# Ionic / Capacitor 接入

> 本文档展示在 Ionic + Capacitor 应用里接入 `@xapiforge/core` 的完整步骤。前置步骤（xapiforge.config.ts / 生成 API / AuthApi / middleware）与 [浏览器接入](./browser.md) 相同，本文只讲差异点。

## 为什么需要单独接入

Capacitor 应用跑在 webview 里，直接用 `fetch` 有三个问题：

1. **CORS 限制**：webview 的 CORS 策略比浏览器严格，跨域请求被拦
2. **证书问题**：自签名 HTTPS 证书在 webview 里无法手动信任
3. **性能**：fetch 走 webview 网络栈，大文件下载慢

解法：注入 `capacitorFetch` 适配器，让 `@xapiforge/core` 走 Capacitor 原生 HTTP（iOS NSURLSession / Android OkHttp），绕过 webview 限制。

## 架构

```text
┌─────────────── Ionic App ──────────────┐
│  业务代码（api.base.GET(...)）          │
├────────────────────────────────────────┤
│  @xapiforge/core                         │
│  └─ createNet({ fetch: capacitorFetch })│  ← 注入 capacitorFetch
├────────────────────────────────────────┤
│  capacitorFetch 适配器（业务侧写）       │
│  └─ CapacitorHttp.request → Response    │  ← 走原生 HTTP
├────────────────────────────────────────┤
│  @capacitor/core（原生 HTTP 插件）       │
│  └─ iOS NSURLSession / Android OkHttp   │
└────────────────────────────────────────┘
```

## 步骤 1：安装依赖

```bash
pnpm add @xapiforge/core @xapiforge/adapter-capacitor
pnpm add @capacitor/core @capacitor/filesystem
pnpm add -D @xapiforge/genapi openapi-fetch
```

> `@capacitor/*` 是原生插件，必须装在应用项目里（不能写在 `@xapiforge/adapter-capacitor` 的 package.json，否则 monorepo install 会 404）。

## 步骤 2：写 capacitorFetch 适配器

`capacitorFetch` 把 `fetch` 签名适配到 `CapacitorHttp.request`。

```typescript
// src/capacitor-fetch.ts
import type { FetchLike } from "@xapiforge/core";

/** 动态加载 @capacitor/core，避免 web 构建时引入原生依赖 */
async function loadCapacitorHttp() {
  const { CapacitorHttp } = await import("@capacitor/core");
  return CapacitorHttp;
}

/** fetch Request → CapacitorHttp options */
async function fetchToCapacitorOptions(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: unknown;
  responseType?: "blob" | "json" | "text" | "arraybuffer";
}> {
  const req = new Request(input, init);
  const url = req.url;
  const method = req.method;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  // body 处理
  let data: unknown;
  if (init?.body) {
    const body = init.body;
    if (typeof body === "string") {
      data = body;
    } else if (body instanceof Blob) {
      // 二进制：转 base64 透传（避免 UTF-8 损坏）
      data = await blobToBase64(body);
      headers["Content-Type"] = body.type || "application/octet-stream";
    } else if (body instanceof ArrayBuffer) {
      data = await blobToBase64(new Blob([body]));
    } else if (body instanceof FormData) {
      // FormData 不支持原生层直接传，退化为 JSON
      data = Object.fromEntries(body.entries());
    }
  }

  return { url, method, headers, data };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** CapacitorHttp response → fetch Response */
function capacitorResponseToWebResponse(capRes: { status: number; headers: Record<string, string>; data: unknown }): Response {
  const headers = new Headers(capRes.headers);
  const body = typeof capRes.data === "string" ? capRes.data : JSON.stringify(capRes.data);
  return new Response(body, {
    status: capRes.status,
    headers
  });
}

export const capacitorFetch: FetchLike = async (input, init) => {
  const http = await loadCapacitorHttp();
  const opts = await fetchToCapacitorOptions(input, init);

  // signal 处理：CapacitorHttp 不支持 abort，用 race 让 JS 侧能立即 reject
  const signal = init?.signal;
  if (!signal) {
    const res = await http.request(opts);
    return capacitorResponseToWebResponse(res);
  }

  if (signal.aborted) {
    throw new DOMException("The user aborted a request", "AbortError");
  }

  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The user aborted a request", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });

    http
      .request(opts)
      .then(res => {
        signal.removeEventListener("abort", onAbort);
        resolve(capacitorResponseToWebResponse(res));
      })
      .catch((e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new DOMException("The user aborted a request", "AbortError"));
          return;
        }
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
};
```

## 步骤 3：初始化时注入 capacitorFetch

```typescript
// src/main.ts
import { AuthService, HttpClient } from "@xapiforge/core";
import { preferencesStore } from "@xapiforge/adapter-capacitor";
import { capacitorFetch } from "./capacitor-fetch";
import { AuthApi } from "./AuthApi";
import { initApi } from "./api";

const BASE_URL = "https://api.example.com";

// HttpClient 注入 capacitorFetch
const httpClient = new HttpClient({ baseURL: BASE_URL, fetch: capacitorFetch });
const authApi = new AuthApi(httpClient, {/* ... */});

const authService = new AuthService({
  tokenStore: preferencesStore("app_token"), // Capacitor Preferences
  authRefresher: {
    async refresh() {
      const r = await authApi.refreshToken(/* ... */);
      return r.token;
    }
  },
  onAuthFailed: () => {
    /* 跳登录 */
  }
});

// createNet 注入 capacitorFetch —— 所有 API 调用走原生 HTTP
initApi("default", {
  baseURL: BASE_URL,
  authService,
  middleware: [/* ... */],
  fetch: capacitorFetch // ← 关键：注入
});
```

## 步骤 4：大文件下载用 downloadFileNative

`api.download(url, { onChunk })` 走 fetch + ReadableStream，但 Capacitor 的 response.body 是 null（一次性返回完整响应），流式下载退化到 blob 模式，大文件会 OOM。

解法：静态文件 URL 下载用 `downloadFileNative`，原生层直写磁盘（0 内存）。

```typescript
import { downloadFileNative } from "@xapiforge/adapter-capacitor";

// 下载到 Documents 目录（原生层流式写盘）
const result = await downloadFileNative({
  url: "https://api.example.com/files/report.pdf",
  path: "report.pdf",
  directory: "DOCUMENTS", // 或 "CACHE" / "EXTERNAL" / "LIBRARY"
  headers: { Authorization: `Bearer ${token}` },
  // 动态鉴权（下载前获取最新 token）
  getHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  onProgress: (bytes, contentLength) => {
    console.log(`${bytes}/${contentLength}`);
  }
});

console.log("下载完成:", result.path);
```

**两种下载 API 分工**：

| API                              | 适用场景                                            | 内存占用                          | 走 middleware |
| -------------------------------- | --------------------------------------------------- | --------------------------------- | ------------- |
| `api.download(url, { onChunk })` | API 返回流（POST 下载，需鉴权/retry/envelope 解包） | 流式：低；Capacitor 退化 blob：高 | ✅            |
| `downloadFileNative(url, path)`  | 静态文件 URL（如 http://xxx/xxx.pdf）               | 0（原生直写磁盘）                 | ❌            |

## 已知限制

1. **CapacitorHttp 不支持真正 abort**：`signal` abort 后 JS 侧立即 reject，但原生请求继续在后台跑
2. **response.body 为 null**：CapacitorHttp 一次性返回完整响应，无 ReadableStream。流式下载需用 `downloadFileNative`
3. **并发下载进度串扰**：Capacitor 的 progress listener 是全局事件，`downloadFileNative` 内部用串行队列保证同时只有一个下载在跑
4. **FormData 不支持**：CapacitorHttp 原生层不直接支持 FormData，适配器退化为 JSON

## 完整示例

完整的 Capacitor 接入示例（含 capacitorFetch + downloadFileNative）见 `examples/demo-app/src/capacitor-fetch.ts`（参考实现）。

## 下一步

- [文件下载详解](../guides/file-download.md) — api.download vs downloadFileNative 选型
- [鉴权详解](../guides/auth.md) — token 刷新机制
