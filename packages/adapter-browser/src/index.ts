/**
 * @xapiforge/adapter-browser — 浏览器 TokenStore adapter
 *
 * 提供 localStorage / sessionStorage / cookie 三种实现。
 */
import type { TokenStore } from "@xapiforge/core";

/** localStorage 实现。SSR 环境调用会抛错。 */
export function localStorageStore(key: string): TokenStore {
  return {
    get: (): string | null => globalThis.localStorage?.getItem(key) ?? null,
    set: (t: string): void => {
      globalThis.localStorage?.setItem(key, t);
    },
    clear: (): void => {
      globalThis.localStorage?.removeItem(key);
    },
  };
}

/** sessionStorage 实现。标签页关闭即失效。 */
export function sessionStorageStore(key: string): TokenStore {
  return {
    get: (): string | null => globalThis.sessionStorage?.getItem(key) ?? null,
    set: (t: string): void => {
      globalThis.sessionStorage?.setItem(key, t);
    },
    clear: (): void => {
      globalThis.sessionStorage?.removeItem(key);
    },
  };
}

/** Cookie 实现（同步）。同域 cookie 自动随请求发送。 */
export function cookieStore(key: string, days = 7): TokenStore {
  return {
    get: (): string | null => readCookie(key),
    set: (t: string): void => {
      writeCookie(key, t, days);
    },
    clear: (): void => {
      writeCookie(key, "", -1);
    },
  };
}

function readCookie(name: string): string | null {
  const m = globalThis.document?.cookie.match(new RegExp("(^| )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[2]!) : null;
}

function writeCookie(name: string, value: string, days: number): void {
  if (!globalThis.document) return;
  const expires = days ? "; expires=" + new Date(Date.now() + days * 864e5).toUTCString() : "";
  globalThis.document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
}
