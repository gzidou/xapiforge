# genapi Hooks

genapi 内核只处理标准 OpenAPI。后端框架或历史服务的特殊 Swagger 形态通过业务 hooks 适配，不进入通用默认规则。

当前公开两个 hook：

```ts
export interface GenapiHookContext {
  projectId: string;
  serviceName: string;
  swaggerPath: string;
  typesPath: string;
  originalDocument?: unknown;
  normalizedDocument?: unknown;
}

export type TransformSwaggerHook = (swagger: unknown, ctx: GenapiHookContext) => Promise<unknown>;

export type TransformTypesHook = (typesContent: string, ctx: GenapiHookContext) => Promise<string>;

export interface GenapiHooks {
  transformSwagger?: TransformSwaggerHook;
  transformTypes?: TransformTypesHook;
}
```

## 执行顺序

```text
读取原 Swagger
  → structuredClone
  → transformSwagger
  → OpenAPI 3.x 与内部 $ref 校验
  → 固定 normalizedDocument
  → openapi-typescript
  → transformTypes
  → 与 index/api-types/manifest 一起进入事务生成
```

同一份深度冻结的 `normalizedDocument` 同时用于 service 类型、endpoint 元数据、schema alias 和 manifest hash。hook 重命名、增加或删除 path/schema 后，所有生成视图保持一致。因为 `openapi-typescript` 的底层 bundler 会修改输入，生成器只向它传递一次性 `structuredClone`；不会重新读取文档或再次执行 hook。

`transformSwagger` 返回 `null`/`undefined`、非 OpenAPI 对象或外部 `$ref` 时立即失败。原 Swagger 文件不会被修改。

`typesPath` 是最终产物的逻辑绝对路径；hook 执行时该文件尚未正式写入。不要在 hook 中直接写它，返回新的字符串即可。

## 配置层级和覆盖规则

root、project 和 service 都可配置 hooks：

```ts
defineConfig({
  hooks: rootHooks,
  projects: [
    {
      name: "portal",
      displayName: "Portal",
      hooks: projectHooks,
      services: [
        { name: "base", displayName: "Base", source: { file: "swagger/base.json" } },
        {
          name: "legacy",
          displayName: "Legacy",
          source: { file: "swagger/legacy.json" },
          hooks: legacyHooks
        },
        {
          name: "standard",
          displayName: "Standard",
          source: { url: "https://api.example.test/openapi.json" },
          hooks: {}
        }
      ]
    }
  ]
});
```

优先级固定为：

```text
service > project > root
```

每一级都是整对象覆盖，不逐字段合并：

- service 没写 `hooks`：继承 project；project 也没写则继承 root。
- service 写自定义对象：只使用该对象。
- service 写 `{}`：显式禁用所有继承 hook。

这样可以确认每个 service 实际运行的是一套完整 hook，不会意外组合来自不同层级的 `transformSwagger` 与 `transformTypes`。

## 示例：过滤非业务 path

```ts
import type { GenapiHooks } from "@xapiforge/genapi";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const filterInternalPaths: GenapiHooks = {
  transformSwagger(swagger) {
    const document = structuredClone(swagger);
    if (!isRecord(document) || !isRecord(document.paths)) {
      return Promise.resolve(document);
    }
    for (const path of Object.keys(document.paths)) {
      if (path.startsWith("/internal/")) delete document.paths[path];
    }
    return Promise.resolve(document);
  }
};
```

## 示例：runtime enum

通用、显式启用的 helper 会返回一套完整 hooks：

```ts
import { createRuntimeEnumHooks } from "@xapiforge/genapi";

const enumHooks = createRuntimeEnumHooks({
  metadata: {
    "Sample.DeviceState": {
      overrideLabels: { 0: "离线", 1: "在线" },
      extensions: {
        colors: { 0: "#999", 1: "#16a34a" },
        icon: { 0: "WifiOff", 1: "Wifi" }
      }
    },
    "Sample.AccessMode": { isFlags: true }
  }
});
```

它读取标准 `enum`、`x-enum-varnames`、`x-enum-labels`，生成 const、Labels、Names、Options、ByLabel、扩展属性和工具函数。Flags 会在 `transformSwagger` 中把 API 字段放宽为 `number`。整组运行时产物按现有 service/prefix/alias 规则进入 `api-types.ts` namespace。

历史字符串格式可通过 `preprocessSwagger` 先规范化：

```ts
const legacyHooks = createRuntimeEnumHooks({
  preprocessSwagger: normalizeLegacySwagger,
  metadata
});
```

真实可编译示例见 `examples/demo-app/hooks/legacy-enum.ts`，详细规则见[枚举生成](./enums.md)。

helper 在 `transformSwagger` 阶段合并 metadata 一次；`transformTypes` 只读取 `ctx.normalizedDocument`，不会重新读取 `ctx.swaggerPath`。业务自定义 hook 也应遵守这一点，避免类型、Options 与 manifest 分别基于不同文档。

## 开发和验证 hook

至少准备一个脱敏 fixture，并验证：

1. 原 Swagger 文件未改变；
2. literal union 与实际序列化值一致；
3. path/schema 增删会同步反映到类型、alias 和 endpoint 统计；
4. 错误 metadata 在正式输出写入前失败；
5. Options、label 覆盖和颜色/图标等 extensions 被实际消费并编译；
6. runtime enum 跟随 service/prefix/flat namespace；
7. `--check` 不修改生成目录；
8. 生成产物可由独立 TypeScript 消费者编译。

```bash
pnpm --filter '@xapiforge/genapi' test
pnpm run generate:api -- --check
```

不要在 hook 中：

- 修改磁盘上的原 Swagger；
- 依赖当前时间或随机值；
- 访问未锁定的远程 `$ref`；
- 把组织名、内网地址或真实业务数据放进 fixture；
- 静默猜测无法识别的历史格式。

完整多服务契约见 [genapi v2](./genapi-v2.md)。
