# 文件下载

先确认 API 边界：`@xapiforge/core` 不导出名为 `api.download` 的公共函数。仓库 demo 中有一套业务层下载封装，`@xapiforge/adapter-capacitor` 则公开提供 `downloadFileNative`。接入时按文件大小、鉴权方式和运行环境选择。

## 能力对照

| 方式                                           | 来自哪里                       | 经过 createNet middleware | 适合场景                           |
| ---------------------------------------------- | ------------------------------ | ------------------------- | ---------------------------------- |
| `HttpClient.request({ responseType: "blob" })` | `@xapiforge/core`              | 否                        | 浏览器小文件、简单 GET             |
| demo 的 `api.download`                         | `examples/demo-app` 业务封装   | 是                        | 需要鉴权、重试、进度或 POST 的下载 |
| `downloadFileNative(options)`                  | `@xapiforge/adapter-capacitor` | 否                        | Capacitor 大文件直接写原生目录     |

生成客户端本身仍可调用 OpenAPI 中声明的文件端点，但是否得到 `Blob` 取决于 OpenAPI 的响应 schema 和底层解析方式。需要进度或流式写盘时，应使用专门的下载封装。

## 浏览器小文件

`HttpClient` 可以把整个响应读成 Blob：

```typescript
import { HttpClient } from "@xapiforge/core";

const http = new HttpClient({ baseURL: "https://api.example.com" });
const response = await http.request({
  method: "GET",
  path: "/files/report.pdf",
  responseType: "blob",
  headers: { Authorization: `Bearer ${accessToken}` }
});

if (!response.ok || !response.blob) {
  throw new Error(`download failed: HTTP ${response.status}`);
}

const objectUrl = URL.createObjectURL(response.blob);
const link = document.createElement("a");
link.href = objectUrl;
link.download = "report.pdf";
link.click();
URL.revokeObjectURL(objectUrl);
```

这条路径不会自动注入 Token、刷新 401、重试 429，也不会解析业务 envelope。上例显式传入了 Authorization；Token 过期时应由业务代码决定如何处理。

## 需要鉴权和进度的下载

`examples/demo-app/src/api/init.ts` 实现了 demo 专用的 `api.download`。它基于无 schema 的 `createNet` client 发请求，因此可以复用鉴权、401 刷新、429 重试和 HTTP 错误归一化，并在浏览器支持 `ReadableStream` 时报告 chunk 和进度。

参考实现：[examples/demo-app/src/api/init.ts](../../examples/demo-app/src/api/init.ts)

它不是 npm 包导出，复制到业务项目时至少要确认：

- 文件端点是否需要业务 envelope 解包。
- GET、POST、query 和 body 的序列化方式。
- `Content-Disposition` 文件名规则。
- 浏览器不支持流式写盘时的内存上限。
- 中止、超时和部分文件如何清理。

不要在业务代码里假定所有生成客户端都有 `download` 方法；只有项目自己注册了这层封装后才能这样调用。

## Capacitor 原生下载

先在应用项目安装原生依赖并同步：

```bash
pnpm add @xapiforge/adapter-capacitor @capacitor/filesystem
pnpm exec cap sync
```

然后直接写入原生目录：

```typescript
import { downloadFileNative } from "@xapiforge/adapter-capacitor";

const result = await downloadFileNative({
  url: "https://api.example.com/files/report.pdf",
  path: "reports/report.pdf",
  directory: "DOCUMENTS",
  getHeaders: async () => ({
    Authorization: `Bearer ${await getLatestAccessToken()}`
  }),
  onProgress(received, total) {
    console.log(`${received}/${total}`);
  }
});

console.log(result.path);
```

`getHeaders` 在下载开始前执行，适合读取最新 Token。它不会自动调用 `AuthService.refreshIfNeeded()`；需要预刷新时由应用在回调中完成。

## 错误和取消

```typescript
import { DownloadFileNativeError, downloadFileNative } from "@xapiforge/adapter-capacitor";

try {
  await downloadFileNative({
    url,
    path: "report.pdf",
    signal: abortController.signal
  });
} catch (error) {
  if (error instanceof DownloadFileNativeError) {
    console.error(error.code, error.cause);
  }
}
```

错误码：

- `MODULE_NOT_FOUND`：应用没有安装或同步 `@capacitor/filesystem`。
- `ABORTED`：JavaScript 侧已取消；原生下载可能仍在后台继续。
- `DOWNLOAD_FAILED`：原生插件返回失败，原始错误保存在 `cause`。

多个 `downloadFileNative` 调用会排队执行，避免 Capacitor 全局 progress 事件串扰。取消后如果产生了部分文件，应用需要按自身策略清理。

## 选型建议

- 浏览器中几十 MB 以内、无需进度：先用 `HttpClient` Blob 模式。
- 需要自动鉴权、POST、进度或分块处理：在业务层维护类似 demo 的下载封装，并纳入业务测试。
- Capacitor 大文件：优先 `downloadFileNative`，在真机上验证目录权限、取消和磁盘空间不足。
- React Native：使用 `react-native-fs`、Expo FileSystem 等应用选定的原生方案；xapiforge 当前没有 RN 下载 adapter。
