/**
 * downloadFileNative 单元测试（mock @capacitor/filesystem）
 *
 * 运行：pnpm test:download
 *
 * 覆盖：
 *   1. URL/path/directory 透传
 *   2. headers / getHeaders 合并（getHeaders 覆盖同名字段）
 *   3. signal pre-aborted → ABORTED
 *   4. signal 中途 abort → ABORTED
 *   5. 串行队列（并发调用按序执行，progress 不串扰）
 *   6. 模块加载失败 → MODULE_NOT_FOUND
 *   7. 原生下载失败 → DOWNLOAD_FAILED（cause 保留原始错误）
 *   8. progress listener 注册和移除
 *   9. 默认 directory（Directory.Documents）
 */
import { downloadFileNative, DownloadFileNativeError } from "@xapiforge/adapter-capacitor";

// ─── 断言工具 ───
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ❌ FAIL: ${msg}`);
  }
}

async function expectThrows(
  fn: () => Promise<unknown>,
  check: (e: unknown) => boolean,
  msg: string,
): Promise<void> {
  try {
    await fn();
    ok(false, `${msg} — expected throw`);
  } catch (e) {
    ok(check(e), `${msg} — unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── mock @capacitor/filesystem ───
interface DownloadCall {
  url: string;
  path: string;
  directory: string;
  headers?: Record<string, string>;
  progress: boolean;
}

interface MockState {
  downloadCalls: DownloadCall[];
  listenerRegistered: number;
  listenerRemoved: number;
}

interface MockConfig {
  resultPath?: string;
  delayMs?: number;
  rejectError?: Error;
  triggerProgress?: { bytes: number; contentLength: number };
}

interface MockFilesystemPlugin {
  downloadFile(opts: DownloadCall): Promise<{ path?: string }>;
  addListener(
    eventName: string,
    listener: (event: { bytes: number; contentLength: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

interface MockFilesystemModule {
  Filesystem: MockFilesystemPlugin;
  Directory: {
    Documents: string;
    Cache: string;
    External: string;
    Library: string;
  };
}

/**
 * 创建 mock @capacitor/filesystem 模块。
 * 返回 { mod, state }：mod 传给 _loader，state 用于断言调用情况。
 */
function createMockFilesystem(config: MockConfig = {}): {
  mod: MockFilesystemModule;
  state: MockState;
} {
  const state: MockState = {
    downloadCalls: [],
    listenerRegistered: 0,
    listenerRemoved: 0,
  };

  let progressListener: ((event: { bytes: number; contentLength: number }) => void) | null = null;

  const Filesystem: MockFilesystemPlugin = {
    downloadFile(opts: DownloadCall): Promise<{ path?: string }> {
      state.downloadCalls.push({ ...opts });

      return new Promise((resolve, reject) => {
        const run = (): void => {
          if (config.rejectError) {
            reject(config.rejectError);
            return;
          }
          if (config.triggerProgress && progressListener) {
            progressListener(config.triggerProgress);
          }
          resolve({ path: config.resultPath });
        };
        if (config.delayMs) {
          setTimeout(run, config.delayMs);
        } else {
          run();
        }
      });
    },
    addListener(
      _eventName: string,
      listener: (event: { bytes: number; contentLength: number }) => void,
    ): Promise<{ remove: () => Promise<void> }> {
      state.listenerRegistered++;
      progressListener = listener;
      return Promise.resolve({
        remove: () => {
          state.listenerRemoved++;
          progressListener = null;
          return Promise.resolve();
        },
      });
    },
  };

  const Directory = {
    Documents: "DOCUMENTS",
    Cache: "CACHE",
    External: "EXTERNAL",
    Library: "LIBRARY",
  };

  return { mod: { Filesystem, Directory }, state };
}

// ─── 测试用例 ───

async function testBasicPassthrough(): Promise<void> {
  console.log("test: URL/path/directory 透传");
  const { mod, state } = createMockFilesystem({ resultPath: "mocked/path" });
  const result = await downloadFileNative({
    url: "http://example.com/file.pdf",
    path: "reports/file.pdf",
    _loader: () => Promise.resolve(mod),
  });

  ok(result.path === "mocked/path", "返回 mock path");
  ok(state.downloadCalls.length === 1, "downloadFile 调用一次");
  ok(state.downloadCalls[0]?.url === "http://example.com/file.pdf", "url 透传");
  ok(state.downloadCalls[0]?.path === "reports/file.pdf", "path 透传");
  ok(state.downloadCalls[0]?.directory === "DOCUMENTS", "默认 directory=DOCUMENTS");
}

async function testCustomDirectory(): Promise<void> {
  console.log("test: 自定义 directory");
  const { mod, state } = createMockFilesystem();
  await downloadFileNative({
    url: "http://example.com/file.pdf",
    path: "cache/file.pdf",
    directory: "CACHE",
    _loader: () => Promise.resolve(mod),
  });

  ok(state.downloadCalls[0]?.directory === "CACHE", "directory=CACHE 透传");
}

async function testHeadersMerge(): Promise<void> {
  console.log("test: headers / getHeaders 合并");
  const { mod, state } = createMockFilesystem();
  await downloadFileNative({
    url: "http://example.com/file.pdf",
    path: "file.pdf",
    headers: { Authorization: "Bearer old", "X-Static": "yes" },
    getHeaders: () => Promise.resolve({ Authorization: "Bearer new" }),
    _loader: () => Promise.resolve(mod),
  });

  const h = state.downloadCalls[0]?.headers;
  ok(h?.Authorization === "Bearer new", "getHeaders 覆盖 headers 同名字段");
  ok(h?.["X-Static"] === "yes", "headers 静态字段保留");
}

async function testSignalPreAborted(): Promise<void> {
  console.log("test: signal pre-aborted → ABORTED");
  const { mod } = createMockFilesystem();
  const controller = new AbortController();
  controller.abort();

  await expectThrows(
    () =>
      downloadFileNative({
        url: "http://example.com/file.pdf",
        path: "file.pdf",
        signal: controller.signal,
        _loader: () => Promise.resolve(mod),
      }),
    (e) => e instanceof DownloadFileNativeError && e.code === "ABORTED",
    "pre-aborted signal 应抛 ABORTED",
  );
}

async function testSignalMidAbort(): Promise<void> {
  console.log("test: signal 中途 abort → ABORTED");
  const { mod } = createMockFilesystem({ delayMs: 100 });
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 20);

  await expectThrows(
    () =>
      downloadFileNative({
        url: "http://example.com/file.pdf",
        path: "file.pdf",
        signal: controller.signal,
        _loader: () => Promise.resolve(mod),
      }),
    (e) => e instanceof DownloadFileNativeError && e.code === "ABORTED",
    "中途 abort 应抛 ABORTED",
  );
}

async function testSerialQueue(): Promise<void> {
  console.log("test: 串行队列（并发按序执行）");
  const executionOrder: string[] = [];
  const { mod, state } = createMockFilesystem({ delayMs: 50, resultPath: "queued" });

  // 包装 downloadFile 记录调用顺序
  const origDownload = mod.Filesystem.downloadFile;
  mod.Filesystem.downloadFile = (opts: DownloadCall): Promise<{ path?: string }> => {
    executionOrder.push(`start:${opts.path}`);
    return origDownload(opts).then((result) => {
      executionOrder.push(`end:${opts.path}`);
      return result;
    });
  };

  // 并发发起 3 个下载
  const results = await Promise.all([
    downloadFileNative({
      url: "http://a.com/1",
      path: "file1",
      _loader: () => Promise.resolve(mod),
    }),
    downloadFileNative({
      url: "http://a.com/2",
      path: "file2",
      _loader: () => Promise.resolve(mod),
    }),
    downloadFileNative({
      url: "http://a.com/3",
      path: "file3",
      _loader: () => Promise.resolve(mod),
    }),
  ]);

  ok(results.length === 3, "3 个下载都完成");
  ok(state.downloadCalls.length === 3, "downloadFile 调用 3 次");

  // 验证串行：start1 → end1 → start2 → end2 → start3 → end3（不交叉）
  const expected = [
    "start:file1",
    "end:file1",
    "start:file2",
    "end:file2",
    "start:file3",
    "end:file3",
  ];
  ok(
    JSON.stringify(executionOrder) === JSON.stringify(expected),
    `串行队列顺序错误：${JSON.stringify(executionOrder)}`,
  );
}

async function testModuleNotFound(): Promise<void> {
  console.log("test: 模块加载失败 → MODULE_NOT_FOUND");
  await expectThrows(
    () =>
      downloadFileNative({
        url: "http://example.com/file.pdf",
        path: "file.pdf",
        _loader: () => Promise.reject(new Error("module not found")),
      }),
    (e) => e instanceof DownloadFileNativeError && e.code === "MODULE_NOT_FOUND",
    "模块加载失败应抛 MODULE_NOT_FOUND",
  );
}

async function testDownloadFailed(): Promise<void> {
  console.log("test: 原生下载失败 → DOWNLOAD_FAILED（cause 保留）");
  const originalError = new Error("network timeout");
  const { mod } = createMockFilesystem({ rejectError: originalError });

  let caught: DownloadFileNativeError | undefined;
  try {
    await downloadFileNative({
      url: "http://example.com/file.pdf",
      path: "file.pdf",
      _loader: () => Promise.resolve(mod),
    });
  } catch (e) {
    if (e instanceof DownloadFileNativeError) caught = e;
  }

  ok(caught !== undefined, "应抛 DownloadFileNativeError");
  ok(caught?.code === "DOWNLOAD_FAILED", "code=DOWNLOAD_FAILED");
  ok(caught?.cause === originalError, "cause 保留原始错误");
}

async function testProgressListener(): Promise<void> {
  console.log("test: progress listener 注册和移除");
  let progressReceived = 0;
  let progressTotal = 0;
  const { mod, state } = createMockFilesystem({
    triggerProgress: { bytes: 500, contentLength: 1000 },
  });

  await downloadFileNative({
    url: "http://example.com/file.pdf",
    path: "file.pdf",
    onProgress: (received, total) => {
      progressReceived = received;
      progressTotal = total;
    },
    _loader: () => Promise.resolve(mod),
  });

  ok(state.listenerRegistered === 1, "注册 1 个 listener");
  ok(state.listenerRemoved === 1, "listener 移除一次");
  ok(progressReceived === 500, "progress received 透传");
  ok(progressTotal === 1000, "progress total 透传");
  ok(state.downloadCalls[0]?.progress === true, "downloadFile progress=true");
}

async function testNoProgressNoListener(): Promise<void> {
  console.log("test: 无 onProgress 时不注册 listener");
  const { mod, state } = createMockFilesystem();
  await downloadFileNative({
    url: "http://example.com/file.pdf",
    path: "file.pdf",
    _loader: () => Promise.resolve(mod),
  });

  ok(state.listenerRegistered === 0, "无 onProgress 不注册 listener");
  ok(state.downloadCalls[0]?.progress === false, "downloadFile progress=false");
}

async function testDefaultPathFallback(): Promise<void> {
  console.log("test: result.path 缺失时回退到 options.path");
  const { mod } = createMockFilesystem({ resultPath: undefined });
  const result = await downloadFileNative({
    url: "http://example.com/file.pdf",
    path: "fallback.pdf",
    _loader: () => Promise.resolve(mod),
  });

  ok(result.path === "fallback.pdf", "result.path 回退到 options.path");
}

// ─── 主入口 ───
async function main(): Promise<void> {
  console.log("=== downloadFileNative 测试 ===\n");

  await testBasicPassthrough();
  await testCustomDirectory();
  await testHeadersMerge();
  await testSignalPreAborted();
  await testSignalMidAbort();
  await testSerialQueue();
  await testModuleNotFound();
  await testDownloadFailed();
  await testProgressListener();
  await testNoProgressNoListener();
  await testDefaultPathFallback();

  console.log(`\n✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("━".repeat(60));

  if (failed > 0) process.exit(1);
}

void main();
