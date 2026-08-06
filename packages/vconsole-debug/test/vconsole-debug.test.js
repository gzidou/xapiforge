import assert from "node:assert/strict";
import test from "node:test";

import {
  clearStorageExcept,
  createVConsoleDebugPlugin,
  readStorageSnapshot,
} from "../dist/index.js";

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, value);
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  clear() {
    this.#values.clear();
  }
}

class FakePlugin {
  events = new Map();

  constructor(id, name) {
    this.id = id;
    this.name = name;
  }

  on(eventName, callback) {
    this.events.set(eventName, callback);
    return this;
  }
}

class FakeVConsole {
  static VConsolePlugin = FakePlugin;
}

test("Storage 快照排序、截断且在数据层脱敏", () => {
  const storage = new MemoryStorage();
  storage.setItem("visible", "12345678901234567890");
  storage.setItem("token", "secret-value");

  const result = readStorageSnapshot({
    id: "local",
    label: "localStorage",
    storage,
    valuePreviewLength: 4,
    isSensitiveKey: (key) => key === "token",
  });

  assert.deepEqual(result, [
    { key: "token", value: "[已脱敏]", sensitive: true },
    { key: "visible", value: "1234567890123456…", sensitive: false },
  ]);
});

test("清理 Storage 时保留明确指定的键", () => {
  const storage = new MemoryStorage();
  storage.setItem("keep", "1");
  storage.setItem("remove-a", "2");
  storage.setItem("remove-b", "3");

  const removed = clearStorageExcept(storage, ["keep"]);

  assert.deepEqual(removed, ["remove-a", "remove-b"]);
  assert.equal(storage.getItem("keep"), "1");
  assert.equal(storage.length, 1);
});

test("插件注册标准面板生命周期与工具栏", () => {
  const plugin = createVConsoleDebugPlugin(FakeVConsole, {
    pluginId: "test-debug",
    pluginName: "Test Debug",
    actions: [{ id: "noop", label: "Noop", run: () => undefined }],
  });

  assert.equal(plugin.id, "test-debug");
  assert.equal(plugin.name, "Test Debug");
  assert.deepEqual([...plugin.events.keys()], ["renderTab", "addTool", "ready", "show", "remove"]);

  let html = "";
  plugin.events.get("renderTab")((value) => {
    html = value;
  });
  assert.match(html, /data-debug-action="noop"/);

  let tools = [];
  plugin.events.get("addTool")((value) => {
    tools = value;
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["刷新", "复制诊断"],
  );
});
