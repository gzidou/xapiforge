/**
 * @xapiforge/core — createAuthMiddleware
 *
 * 鉴权 middleware：注入 token + 401 refresh + 通知 createNet 重发。
 *
 * 工作流程：
 *
 *   onRequest:
 *     ┌─────────────────────────────────────┐
 *     │  authService.getToken()             │
 *     │  ├─ 有 token → set Authorization    │
 *     │  └─ 无 token → 不设 header           │
 *     └─────────────────────────────────────┘
 *
 *   onResponse:
 *     ┌─────────────────────────────────────┐
 *     │  status === 401 ?                   │
 *     │  ├─ 否 → return response            │
 *     │  └─ 是 → 用 request token 判定：      │
 *     │       ├─ reqToken != lastToken      │
 *     │       │   （并发 401：旧 token）      │
 *     │       │   → refreshIfNeeded → RetryableError│
 *     │       ├─ reqToken == lastToken + 窗口内│
 *     │       │   （重发 401：token 被撤销）   │
 *     │       │   → AuthError + onAuthFailed  │
 *     │       └─ reqToken == lastToken + 窗口外│
 *     │           （首次/窗口过期 401）        │
 *     │           → refreshIfNeeded → RetryableError│
 *     └─────────────────────────────────────┘
 *
 * 为什么 refresh 成功后抛 RetryableError 而不是自己重发？
 *   因为 middleware 自己重发（fetch(request.clone())）会绕过 middleware 链，
 *   后续 middleware（envelope 解包）不会执行。
 *   抛 RetryableError 让 createNet 的 retry loop 重发，走完整 middleware 链。
 *
 * 重发时新 token 怎么注入？
 *   createNet retry loop 重发时，onRequest 会再次执行，
 *   authService.getToken() 返回新 token（refreshIfNeeded 已更新 tokenStore）。
 *
 * 并发 401 vs 重发 401 怎么区分？（v0.2.1 修复）
 *   并发 401：多个请求同时发，第一个触发 refresh，其他 onResponse 时 refresh 已完成。
 *     但它们的 request 用的是旧 token（refresh 前注入的）→ reqToken != lastToken
 *   重发 401：createNet retry 重发，onRequest 注入新 token → reqToken == lastToken
 *   用 request 的 Authorization header 与 authService.getLastRefreshedToken() 比较：
 *     - 不同 → 并发 401，refreshIfNeeded（窗口内返回 lastToken）→ RetryableError
 *     - 相同 + 窗口内 → 重发 401，token 被服务端撤销 → AuthError + onAuthFailed
 *     - 相同 + 窗口外 → 窗口过期，refreshIfNeeded → RetryableError
 *
 * 死循环防护：
 *   窗口内重发仍 401（reqToken == lastToken + 窗口内）= token 被服务端撤销
 *     → authService.notifyAuthFailed + 抛 AuthError（业务侧跳登录已触发）
 *   （v0.2 修复：原实现窗口内 401 不调 onAuthFailed，用户卡在 RetryableError）
 */

import { AuthError, RetryableError } from "../errors.js";
import type { AuthService } from "../auth-service.js";
import type { Middleware } from "../types.js";
import { readResponseBody } from "./http-error-mw.js";

export function createAuthMiddleware(authService: AuthService): Middleware {
  return {
    /**
     * onRequest: 注入 Authorization header
     *
     * 注意：不在这里抛错。无 token 时也不抛（有些端点不需要鉴权，如 login）。
     * 401 由 onResponse 处理。
     */
    async onRequest({ request }) {
      const token = await authService.getToken();
      if (token) {
        request.headers.set("Authorization", `Bearer ${token}`);
      }
      return request;
    },

    /**
     * onResponse: 401 处理
     *
     * 只看 HTTP 401，不看 body（envelope 由业务 middleware 处理）。
     * 业务 200 鉴权码（如微信 errcode）由业务 middleware 自己判定 + 抛 RetryableError。
     *
     * 用 request 的 Authorization header 区分并发 401 和重发 401（v0.2.1 修复）：
     *   1. reqToken != lastToken → 并发 401（旧 token）→ refreshIfNeeded → RetryableError
     *   2. reqToken == lastToken + 窗口内 → 重发 401（token 被撤销）→ AuthError
     *   3. reqToken == lastToken + 窗口外 → 首次/过期 401 → refreshIfNeeded → RetryableError
     *
     * 为什么用 request token 而不是 isRefreshing()？
     *   并发请求的 onResponse 串行执行，第一个完成 refresh 后 inflight 已清空，
     *   后续请求检查 isRefreshing() 会返回 false → 误判为重发 401 → 误抛 AuthError。
     *   用 request token 比较：旧 token 必然 != refresh 后的 lastToken，准确区分。
     */
    async onResponse({ request, response }) {
      if (response.status !== 401) return response;

      // 从 request header 提取当前请求用的 token
      const authHeader = request.headers.get("Authorization") ?? "";
      const reqToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const lastToken = authService.getLastRefreshedToken();

      // 1. reqToken != lastToken → 并发 401 或首次 401
      //    （并发：旧 token；首次：lastToken 为 null）
      //    refreshIfNeeded 内部单飞 + 窗口保护，不会重复 refresh
      if (reqToken !== lastToken) {
        try {
          await authService.refreshIfNeeded();
          // refresh 成功（或窗口内返回 lastToken）→ 抛 RetryableError 让 createNet 重发
          throw new RetryableError("auth retry needed", {
            reason: "auth",
            response,
          });
        } catch (e) {
          if (e instanceof RetryableError) throw e;
          if (e instanceof AuthError) throw e;
          throw new AuthError(`auth refresh failed: ${(e as Error).message ?? e}`, { cause: e });
        }
      }

      // 2. reqToken == lastToken → 重发 401（用 refresh 后的 token 仍 401）
      //    窗口内 → token 被服务端撤销 → onAuthFailed + AuthError
      //    （v0.2 修复：原实现窗口内 401 不调 onAuthFailed，用户卡死）
      if (authService.isWithinRefreshWindow()) {
        authService.notifyAuthFailed("token rejected after fresh refresh");
        throw new AuthError("token rejected after fresh refresh", {
          status: response.status,
          response,
          body: await readResponseBody(response),
        });
      }

      // 3. reqToken == lastToken + 窗口外 → 窗口过期后的重发 401 → 再 refresh
      //    （极少见：refresh 后 >30s，token 又过期。正常路径重发一次）
      try {
        await authService.refreshIfNeeded();
        throw new RetryableError("auth retry needed (window expired)", {
          reason: "auth",
          response,
        });
      } catch (e) {
        if (e instanceof RetryableError) throw e;
        if (e instanceof AuthError) throw e;
        throw new AuthError(`auth refresh failed: ${(e as Error).message ?? e}`, { cause: e });
      }
    },
  };
}
