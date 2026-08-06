/**
 * @xapiforge/core — AuthService（鉴权状态机）
 *
 * 独立于请求流程。只管 token 存取 + 单飞 refresh + 窗口保护 + 超时 + onAuthFailed。
 *
 * 设计动机（为什么独立成类）：
 *   v0.1 的 refresh 逻辑分散在 setup.ts（TokenRefresher）和 openapi-bridge.ts（闭包）两处，
 *   实现不一致。v0.2 把 refresh 收敛到 AuthService 一处，请求流程（createAuthMiddleware）
 *   只调 authService.getToken() / refreshIfNeeded()，不知道 refresh 怎么实现。
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │                   AuthService 状态机                              │
 * │                                                                  │
 * │  getToken()       ─→ tokenStore.get()                            │
 * │                       （不触发 refresh）                           │
 * │                                                                  │
 * │  refreshIfNeeded() ─→ 窗口内？ ─→ 返回上次 token                  │
 * │                       ├─ 否 → 已有 inflight？ ─→ 等 inflight      │
 * │                       └─ 否 → 发起 refresh（单飞）                 │
 * │                                  ├─ 成功 → tokenStore.set + 缓存   │
 * │                                  └─ 失败 → onAuthFailed + AuthError│
 * │                                                                  │
 * │  refresh()        ─→ 强制 refresh（绕过窗口，仍单飞）              │
 * │                                                                  │
 * │  clearToken()     ─→ tokenStore.clear()                          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 单飞语义：
 *   并发 10 个 401 → 只触发 1 次 refresh。其他 9 个等同一个 Promise，
 *   拿到**同一个新 token** 后各自用新 token 重试原请求。
 *
 * 窗口保护语义：
 *   refresh 成功后 30s 内，再次 refreshIfNeeded 直接返回上次 token，不再 refresh。
 *   防止「refresh 成功 → 重发仍 401 → 再 refresh」死循环。
 *   如果重发仍 401，说明 token 被服务端撤销 → onAuthFailed 跳登录。
 *
 * 超时保护语义：
 *   refresh 端点死锁 / 网络断开 → 并发请求永久挂起。
 *   超时抛 AuthError，所有 await refreshIfNeeded 的请求同 reject → onAuthFailed。
 *
 * 窗口内重发仍 401（token 被服务端撤销）：
 *   auth-mw onResponse 401 时先调 isWithinRefreshWindow() 判定：
 *     - 窗口内 → notifyAuthFailed("token rejected after fresh refresh") + 抛 AuthError
 *     - 窗口外 → refreshIfNeeded（正常路径）
 *   （v0.2 修复：原实现窗口内重发仍 401 时不调 onAuthFailed，用户卡死在 RetryableError）
 *
 * clearToken 竞态保护（epoch）：
 *   clearToken() 时 epoch++，doRefresh 在写 tokenStore 前检查 epoch 是否变化。
 *   变化则丢弃 refresh 结果（不写 tokenStore，不调 onAuthFailed），抛 AuthError。
 *   防止"登出时正好 refresh 在飞 → refresh 完成写回 token → 登出后被覆盖"竞态。
 */

import { AuthError, NetworkError } from "./errors.js";
import type { AuthServiceConfig } from "./types.js";

const DEFAULT_REFRESH_WINDOW_MS = 30_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const TOKEN_MISSING_DURING_REFRESH_WINDOW = "token missing during refresh window";

export class AuthService {
  private readonly config: Required<
    Pick<AuthServiceConfig, "refreshWindowMs" | "refreshTimeoutMs">
  > &
    Pick<AuthServiceConfig, "tokenStore" | "authRefresher" | "onAuthFailed" | "logger">;

  /** 正在飞的 refresh Promise（单飞锁）。null 表示没有 refresh 在进行 */
  private inflight: Promise<string> | null = null;

  /** 上次 refresh 成功的时间戳（用于窗口保护） */
  private lastRefreshAt = 0;

  /** 上次 refresh 成功的 token（窗口内直接返回） */
  private lastToken: string | null = null;

  /**
   * clearToken 竞态保护的 epoch 计数器。
   * clearToken() 时 ++，doRefresh 在写 tokenStore 前后检查 epoch 是否变化。
   * 变化则丢弃 refresh 结果（不写 store，不调 onAuthFailed），抛 AuthError。
   */
  private epoch = 0;

  constructor(config: AuthServiceConfig) {
    this.config = {
      tokenStore: config.tokenStore,
      authRefresher: config.authRefresher,
      onAuthFailed: config.onAuthFailed,
      refreshWindowMs: config.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS,
      refreshTimeoutMs: config.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
      logger: config.logger,
    };
  }

  /**
   * 拿当前 token（不触发 refresh）。
   * createAuthMiddleware 的 onRequest 调这个，注入 Authorization header。
   */
  async getToken(): Promise<string | null> {
    return this.config.tokenStore.get();
  }

  /**
   * 是否有 refresh 正在进行（inflight 存在）。
   *
   * 调用场景：auth-mw onResponse 收到 401 时判定。
   *   - true  → 有并发 refresh 在飞 → 等 inflight（不是重发 401）
   *   - false → 无 inflight，可能是首次 401 或 refresh 后重发 401
   */
  isRefreshing(): boolean {
    return this.inflight !== null;
  }

  /**
   * 是否在 refresh 窗口保护期内。
   *
   * 调用场景：auth-mw onResponse 收到 401 时（已确认无 inflight）再判定。
   *   - true  → 刚 refresh 成功过（窗口内）仍 401，说明 token 被服务端撤销 → notifyAuthFailed
   *   - false → 首次 401 或窗口已过期 → refreshIfNeeded（正常路径）
   */
  isWithinRefreshWindow(): boolean {
    if (this.lastRefreshAt <= 0) return false;
    return Date.now() - this.lastRefreshAt < this.config.refreshWindowMs;
  }

  /**
   * 最近一次 refresh 成功后的 token（初始为 null）。
   *
   * 调用场景：auth-mw onResponse 401 时，比较 request token 和 lastToken：
   *   - 不同 → 并发 401（request 用的旧 token，refresh 已发生）→ refreshIfNeeded → RetryableError
   *   - 相同 + 窗口内 → 重发 401（request 用的就是 refresh 后的 token，仍 401）→ AuthError
   *   - 相同 + 窗口外 → 窗口过期后的 401 → refreshIfNeeded → RetryableError
   */
  getLastRefreshedToken(): string | null {
    return this.lastToken;
  }

  /**
   * 主动触发 onAuthFailed 回调（业务侧跳登录）。
   *
   * 调用场景：
   *   1. doRefresh 内部 refresh 失败（已自动调）
   *   2. auth-mw 窗口内重发仍 401（token 被服务端撤销，主动调）
   *
   * 封装为 public 方法的目的：
   *   - 统一 onAuthFailed 调用入口（防 callback 抛错 + 日志）
   *   - auth-mw 不需要直接访问 config.onAuthFailed
   */
  notifyAuthFailed(reason: string): void {
    const { onAuthFailed, logger } = this.config;
    logger?.error?.(`[net] auth failed: ${reason}`);
    try {
      onAuthFailed();
    } catch (cbErr) {
      logger?.error?.("[net] onAuthFailed callback error:", cbErr);
    }
  }

  /**
   * 单飞 refresh（含窗口保护）。
   *
   * 调用场景：createAuthMiddleware 收到 401 时调。
   *
   * 流程：
   *   1. 窗口内（lastRefreshAt + refreshWindowMs > now）
   *      - tokenStore 仍有 token → 返回 lastToken
   *      - tokenStore 已为空 → 视为会话被外部清除，清运行时缓存并触发 onAuthFailed
   *   2. 已有 inflight → 等 inflight（单飞）
   *   3. 发起 refresh（带超时）
   *      - 成功 → tokenStore.set + 更新 lastRefreshAt/lastToken + 返回 token
   *      - 失败 → onAuthFailed + 抛 AuthError
   *
   * @returns 新 access_token
   * @throws AuthError refresh 失败 / 超时
   */
  async refreshIfNeeded(): Promise<string> {
    const now = Date.now();
    const { refreshWindowMs, logger } = this.config;

    // 1. 窗口保护：30s 内已 refresh 成功过 → 优先复用上次 token。
    //    tokenStore 为 null 表示会话已被业务代码、另一个标签页或外部工具明确清除，
    //    此时不能用内存 lastToken 复活登录态；同时清掉窗口缓存和 refresh 竞态状态。
    //    tokenStore 仍有旧 token 时才写回 lastToken，用于收敛并发 401 的旧请求。
    if (this.lastRefreshAt > 0 && now - this.lastRefreshAt < refreshWindowMs) {
      if (this.lastToken) {
        logger?.debug?.("[net] refreshIfNeeded: within window, return last token");
        const current = await this.config.tokenStore.get();
        if (current === null) {
          logger?.debug?.("[net] refreshIfNeeded: token store cleared during refresh window");
          try {
            await this.clearToken();
          } catch (clearError) {
            logger?.error?.("[net] failed to clear missing token state:", clearError);
          }
          this.notifyAuthFailed(TOKEN_MISSING_DURING_REFRESH_WINDOW);
          throw new AuthError(TOKEN_MISSING_DURING_REFRESH_WINDOW);
        }
        if (current !== this.lastToken) {
          await this.config.tokenStore.set(this.lastToken);
        }
        return this.lastToken;
      }
    }

    // 2. 单飞：已有 refresh 在飞 → 等它
    if (this.inflight) {
      logger?.debug?.("[net] refreshIfNeeded: inflight, wait");
      return this.inflight;
    }

    // 3. 发起 refresh
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * 强制 refresh（绕过窗口保护，但仍单飞）。
   *
   * 调用场景：业务侧主动登出 / token 被撤销时。
   */
  async refresh(): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * 清除 token（登出时调）。
   *
   * 竞态保护：epoch++ 让正在飞的 doRefresh 在写 tokenStore 时检测到 epoch 变化，
   * 丢弃 refresh 结果（不写 store，不调 onAuthFailed），抛 AuthError。
   * 防止"登出时正好 refresh 在飞 → refresh 完成写回 token → 登出后被覆盖"。
   */
  async clearToken(): Promise<void> {
    this.epoch++;
    this.lastRefreshAt = 0;
    this.lastToken = null;
    await this.config.tokenStore.clear();
  }

  /**
   * 实际执行 refresh（带超时）。
   *
   * 失败处理：
   *   - 任何错误 → 调 onAuthFailed（业务侧跳登录）
   *   - 转换为 AuthError 抛出（所有 await refreshIfNeeded 的并发请求同 reject）
   *
   * 注意：onAuthFailed 只调一次（在 finally 之前），即使有 10 个并发请求。
   * 因为它们共享同一个 inflight Promise，doRefresh 只执行一次。
   *
   * epoch 竞态保护：
   *   - 记录 startEpoch = this.epoch
   *   - refresh 完成 + tokenStore.set 前后检查 epoch 是否变化
   *   - 变化（clearToken 发生）→ 丢弃结果，不写 store，不调 onAuthFailed，抛 AuthError
   *   （v0.2 修复：原实现 clearToken 时 inflight refresh 完成会写回 token + 触发 onAuthFailed）
   */
  private async doRefresh(): Promise<string> {
    const { authRefresher, tokenStore, refreshTimeoutMs, logger } = this.config;
    const startEpoch = this.epoch;

    logger?.debug?.("[net] refresh: starting");
    try {
      // refresh 本身可能挂起（网络断 / 服务死锁），加超时
      const token = await withTimeout(
        authRefresher.refresh(),
        refreshTimeoutMs,
        "[net] refresh timeout",
      );

      // clearToken 竞态检查 1：refresh 期间 clearToken 发生 → 丢弃结果
      if (startEpoch !== this.epoch) {
        logger?.debug?.("[net] refresh: discarded (token cleared during refresh)");
        throw new AuthError("refresh discarded (token cleared)");
      }

      // tokenStore.set 也可能挂起（Capacitor SecureStorage 卡住），加超时
      await withTimeout(
        Promise.resolve(tokenStore.set(token)),
        refreshTimeoutMs,
        "[net] refresh: tokenStore.set timeout",
      );

      // clearToken 竞态检查 2：tokenStore.set 期间 clearToken 发生 → 丢弃结果
      if (startEpoch !== this.epoch) {
        logger?.debug?.("[net] refresh: discarded (token cleared during set)");
        throw new AuthError("refresh discarded (token cleared)");
      }

      // 成功：更新缓存
      this.lastRefreshAt = Date.now();
      this.lastToken = token;

      logger?.debug?.("[net] refresh: ok, token updated");
      return token;
    } catch (e) {
      // clearToken 导致的丢弃 → 不调 onAuthFailed（用户主动登出，不是鉴权失败）
      if (startEpoch !== this.epoch) {
        logger?.debug?.("[net] refresh: discarded, skip onAuthFailed");
        if (e instanceof AuthError) throw e;
        throw new AuthError("refresh discarded (token cleared)");
      }

      logger?.error?.("[net] refresh failed:", e);

      // 失败：调 onAuthFailed（业务侧跳登录）
      // 注意：这里只调一次，因为 doRefresh 只执行一次（单飞）
      this.notifyAuthFailed(`refresh failed: ${(e as Error).message ?? e}`);

      // 转换为 AuthError 抛出
      if (e instanceof AuthError) throw e;
      if (e instanceof NetworkError) {
        throw new AuthError(`refresh failed: ${e.message}`, { cause: e });
      }
      throw new AuthError(`refresh failed: ${(e as Error).message ?? e}`, { cause: e });
    }
  }
}

/**
 * 给 Promise 加超时（不破坏原 Promise 链）。
 *
 * 超时抛 NetworkError，AuthService.doRefresh 会 catch 转 AuthError。
 *
 * 实现细节：
 *   - 用 Promise.race 竞争原 Promise 和超时 Promise
 *   - 超时 Promise 永不 resolve，只在 setTimeout 后 reject
 *   - finally 里 clearTimeout 避免内存泄漏
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new NetworkError(`${label} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
