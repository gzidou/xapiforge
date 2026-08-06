/**
 * AuthApi — Demo项目登录 / 刷新 token 接口
 *
 * v0.2：用 HttpClient（@xapiforge/core）调 OAuth2 /connect/token 端点。
 *
 * 为什么用 HttpClient 而不是 createNet？
 *   因为 /connect/token 是鉴权端点，不能走 middleware 链（会循环：auth middleware
 *   注入 token → 调 /connect/token → 401 → refresh → 调 /connect/token → 死循环）。
 *   HttpClient 是纯 HTTP，不带 middleware，安全。
 *
 * 关键事实（ABP 框架 + OAuth2 password grant）：
 *   - URL: /connect/token（swagger 不暴露，必须手写）
 *   - Content-Type: application/x-www-form-urlencoded（不是 JSON）
 *   - body: username, password, client_id, scope, grant_type
 *   - scope 必须 URL 编码（"offline_access Infrastructure" → "offline_access%20Infrastructure"）
 *   - ⚠ URLSearchParams.toString() 会自动把 %20 转 +，所以手动拼字符串
 *   - 可选 header: __tenant（ABP 多租户）
 *
 * 响应格式（OAuth2 标准，snake_case）：
 *   { access_token, refresh_token, token_type, expires_in }
 *
 * 错误响应（OAuth2 标准）：
 *   { error, error_description, error_uri }
 */

import { NetworkError } from "@xapiforge/core";
import type { HttpClient } from "@xapiforge/core";

/** 业务内部用的 token 结构（camelCase） */
export interface AuthPojo {
  token: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn: number;
}

/** OAuth2 /connect/token 响应（snake_case） */
interface OAuth2TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/** OAuth2 /connect/token 错误响应 */
interface OAuth2ErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/** AuthApi 配置（由 main.ts 注入） */
export interface AuthApiConfig {
  /** token endpoint 路径，如 "/connect/token" */
  tokenUrl: string;
  /** OAuth2 client_id，如 "Infrastructure_Web" */
  clientId: string;
  /** OAuth2 scope，如 "offline_access Infrastructure" */
  scope: string;
}

/** 业务侧的统一错误（含 OAuth2 + 网络错误） */
export class AuthLoginError extends Error {
  readonly isAuthLoginError = true as const;
  constructor(
    message: string,
    readonly oauth2?: OAuth2ErrorResponse,
  ) {
    super(message);
    this.name = "AuthLoginError";
  }
}

export class AuthApi {
  private readonly http: HttpClient;
  private readonly config: AuthApiConfig;

  constructor(http: HttpClient, config: AuthApiConfig) {
    this.http = http;
    this.config = config;
  }

  /**
   * 登录（password grant）。
   *
   * 流程：
   *   1. 拼 x-www-form-urlencoded body（手动拼，避免 URLSearchParams 的 %20→+ 问题）
   *   2. HttpClient.request POST
   *   3. 解析响应（OAuth2 成功 / 错误）
   *   4. snake_case → camelCase
   *
   * @param username 用户名
   * @param password 密码
   * @param tenant ABP 多租户（可选，传则加 __tenant header）
   */
  async login(username: string, password: string, tenant?: string): Promise<AuthPojo> {
    const body = this.buildFormBody({
      username,
      password,
      grant_type: "password",
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (tenant) {
      headers.__tenant = tenant;
    }

    let res;
    try {
      res = await this.http.request({
        method: "POST",
        path: this.config.tokenUrl,
        body,
        headers,
      });
    } catch (e) {
      // HttpClient 抛 NetworkError（fetch 失败 / 超时）
      if (e instanceof NetworkError) {
        throw new AuthLoginError(`login network error: ${e.message}`);
      }
      throw e;
    }

    // 解析响应
    const json = this.parseJson(res.bodyText);
    if (!res.ok || this.isOAuth2Error(json)) {
      const err = json as OAuth2ErrorResponse;
      throw new AuthLoginError(err.error_description || err.error || `HTTP ${res.status}`, err);
    }

    return this.toAuthPojo(json);
  }

  /**
   * 刷新 token（refresh_token grant）。
   *
   * 被 AuthService.authRefresher.refresh() 调用。
   * 不走 middleware 链（HttpClient 纯 HTTP），避免循环。
   */
  async refreshToken(refreshToken: string): Promise<AuthPojo> {
    const body = this.buildFormBody({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    let res;
    try {
      res = await this.http.request({
        method: "POST",
        path: this.config.tokenUrl,
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (e) {
      if (e instanceof NetworkError) {
        throw new AuthLoginError(`refresh network error: ${e.message}`);
      }
      throw e;
    }

    const json = this.parseJson(res.bodyText);
    if (!res.ok || this.isOAuth2Error(json)) {
      const err = json as OAuth2ErrorResponse;
      throw new AuthLoginError(err.error_description || err.error || `HTTP ${res.status}`, err);
    }

    return this.toAuthPojo(json);
  }

  /**
   * 拼 x-www-form-urlencoded body。
   *
   * ⚠ 关键陷阱：URLSearchParams.toString() 会把 %20 转 +，
   *   后端不认 + 编码的空格（scope 字段尤其敏感）。
   *   解法：手动拼字符串，用 encodeURIComponent（保留 %20）。
   */
  private buildFormBody(params: Record<string, string>): string {
    // 加入固定参数（client_id, scope）
    const allParams: Record<string, string> = {
      client_id: this.config.clientId,
      scope: this.config.scope,
      ...params,
    };

    return Object.entries(allParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }

  private parseJson(text: string): unknown {
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AuthLoginError(`response not JSON: ${text.slice(0, 100)}`);
    }
  }

  private isOAuth2Error(json: unknown): boolean {
    return typeof json === "object" && json !== null && "error" in json;
  }

  /** snake_case → camelCase 转换 */
  private toAuthPojo(json: unknown): AuthPojo {
    const p = json as Partial<OAuth2TokenResponse>;
    if (
      typeof p.access_token !== "string" ||
      typeof p.token_type !== "string" ||
      typeof p.expires_in !== "number"
    ) {
      throw new AuthLoginError("Invalid auth response: missing token fields");
    }
    return {
      token: p.access_token,
      refreshToken: p.refresh_token,
      tokenType: p.token_type,
      expiresIn: p.expires_in,
    };
  }
}
