# 文件下载

> 本文档详解 `@xapiforge/core` 的文件下载机制：api.download、流式模式、断点续传、Capacitor 原生下载。

## 两种下载 API

| API                              | 适用场景                                       | 内存占用                          | 走 middleware | 运行时       |
| -------------------------------- | ---------------------------------------------- | --------------------------------- | ------------- | ------------ |
| `api.download(url, { onChunk })` | API 返回流（POST 下载，需鉴权/retry/envelope） | 流式：低；Capacitor 退化 blob：高 | ✅            | 全部         |
| `downloadFileNative(url, path)`  | 静态文件 URL（如 http://xxx/xxx.pdf）          | 0（原生直写磁盘）                 | ❌            | 仅 Capacitor |

**选型决策树**：

```text
要下载的文件是？
├─ API 返回流（POST + body，需鉴权）
│  └─ api.download(url, { onChunk })
│
└─ 静态文件 URL（GET，URL 自带签名 or 公开）
   ├─ 浏览器环境
   │  └─ api.download(url)（走 fetch，支持进度）
   │
   └─ Capacitor 环境 + 大文件（>100MB）
      └─ downloadFileNative(url, path)（原生直写磁盘，0 内存）
```

## api.download 用法

### 小文件（内存模式）

```typescript
const { blob, filename } = await api.download("/api/file/download?id=123", {
  onProgress: (received, total) => {
    console.log(`${received}/${total}`); // 0/102400 → 102400/102400
  }
});

// 触发浏览器下载
const url = URL.createObjectURL(blob!);
const a = document.createElement("a");
a.href = url;
a.download = filename ?? "download.bin";
a.click();
URL.revokeObjectURL(url);
```

### 大文件（流式模式，浏览器）

```typescript
// 用 File System Access API 流式写盘（Chromium 浏览器）
const handle = await window.showSaveFilePicker({ suggestedName: "big.zip" });
const writable = await handle.createWritable();

await api.download("/api/big-file", {
  onChunk: async chunk => {
    await writable.write(chunk); // 每个 chunk 直接写盘，不累积
  },
  onProgress: (received, total) => {
    updateProgressBar(received, total);
  }
});

await writable.close();
```

### 断点续传

```typescript
// 记录已下载字节
let downloaded = 0;
try {
  await api.download("/api/big-file", {
    rangeFrom: downloaded, // 自动加 Range: bytes=downloaded-
    onChunk: async (chunk, received) => {
      downloaded = received;
      await saveChunk(chunk);
    },
    onProgress: received => {
      downloaded = received;
    }
  });
} catch (e) {
  // 中断后，downloaded 保留已下载字节，下次从 rangeFrom: downloaded 继续
  console.log("已下载", downloaded, "字节");
}
```

### POST 下载（API 返回流）

```typescript
const { blob } = await api.download("/api/export/report", {
  method: "POST",
  body: JSON.stringify({ startDate: "2026-01-01", endDate: "2026-12-31" }),
  headers: { "Content-Type": "application/json" },
  onProgress: (r, t) => updateProgress(r, t)
});
```

## downloadFileNative 用法（仅 Capacitor）

### 基本用法

```typescript
import { downloadFileNative } from "@xapiforge/adapter-capacitor";

const result = await downloadFileNative({
  url: "https://api.example.com/files/report.pdf",
  path: "report.pdf",
  directory: "DOCUMENTS", // Documents / Cache / External / Library
  headers: { Authorization: `Bearer ${token}` },
  onProgress: (bytes, contentLength) => {
    console.log(`${bytes}/${contentLength}`);
  }
});

console.log("下载完成:", result.path);
```

### 动态鉴权

下载前获取最新 token（避免静态 headers 里 token 过期）：

```typescript
const result = await downloadFileNative({
  url: "https://api.example.com/files/report.pdf",
  path: "report.pdf",
  directory: "DOCUMENTS",
  // getHeaders 优先级高于 headers（覆盖同名字段）
  getHeaders: async () => {
    const token = await authService.getToken();
    return { Authorization: `Bearer ${token}` };
  },
  onProgress: (bytes, total) => updateProgress(bytes, total)
});
```

### 取消下载

```typescript
const controller = new AbortController();

// 取消
controller.abort();

try {
  await downloadFileNative({
    url: "...",
    path: "...",
    directory: "DOCUMENTS",
    signal: controller.signal // 传入 AbortSignal
  });
} catch (e) {
  if (e instanceof Error && e.name === "AbortError") {
    console.log("用户取消");
  }
}
```

> ⚠ CapacitorHttp 不支持真正 abort。`signal` abort 后 JS 侧立即 reject，但原生请求继续在后台跑。

### 错误处理

```typescript
import { downloadFileNative, DownloadFileNativeError } from "@xapiforge/adapter-capacitor";

try {
  await downloadFileNative({/* ... */});
} catch (e) {
  if (e instanceof DownloadFileNativeError) {
    switch (e.code) {
      case "MODULE_NOT_FOUND":
        console.error("@capacitor/filesystem 未安装");
        break;
      case "ABORTED":
        console.log("用户取消");
        break;
      case "DOWNLOAD_FAILED":
        console.error("原生下载失败:", e.cause); // 原始错误
        break;
    }
  }
}
```

## 并发下载（Capacitor）

Capacitor 的 progress listener 是全局事件，多个 `downloadFileNative` 并发时进度会串扰。`downloadFileNative` 内部用串行队列保证同时只有一个下载在跑：

```typescript
// 3 个下载会自动排队（FIFO），不会并发
const [r1, r2, r3] = await Promise.all([downloadFileNative({ url: "...", path: "file1.pdf", directory: "DOCUMENTS" }), downloadFileNative({ url: "...", path: "file2.pdf", directory: "DOCUMENTS" }), downloadFileNative({ url: "...", path: "file3.pdf", directory: "DOCUMENTS" })]);
```

## 已知限制

| 限制                            | api.download                 | downloadFileNative             |
| ------------------------------- | ---------------------------- | ------------------------------ |
| Capacitor response.body 为 null | 退化 blob 模式（大文件 OOM） | 不受影响（原生层处理）         |
| 取消请求                        | ✅ signal 真正 abort         | ❌ signal abort 后原生请求继续 |
| 上传进度                        | ❌ fetch API 限制            | N/A                            |
| 并发进度                        | ✅ 各请求独立                | ⚠ 串行队列（同时只一个）       |
| middleware（auth/retry）        | ✅                           | ❌                             |

## 下一步

- [Capacitor 接入](../getting-started/ionic-capacitor.md) — capacitorFetch 适配器
- [错误处理](./error-handling.md) — DownloadFileNativeError 错误码
