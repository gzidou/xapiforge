# genapi v2：单服务与多服务接入

genapi v2 把每个 OpenAPI service 视为独立类型域，并为同一 project 下的服务提供统一运行时入口。它不会跨 service 猜测或合并 schema。

## 先区分两个地址

- `xapiforge.config.ts` 中的 `baseHost`、`services[].baseHost` 和 `port` 只用于 `xapiforge-fetch` 下载 Swagger。
- `createXxxClient()` 的 `baseURL` 只用于应用运行时请求。

生成器不会从下载地址推导运行时地址。测试、网关和生产环境应在应用初始化时分别注入。

## 配置 project 与 service

单服务：

```ts
import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  defaultPath: "/swagger/v1/swagger.json",
  timeoutMs: 15_000,
  outputDir: "swagger",
  genOutputDir: "src/api/gen",
  mode: "offline",
  projects: [
    {
      name: "portal",
      displayName: "Portal",
      baseHost: "http://localhost:7001",
      services: [{ name: "base", displayName: "Base API", port: 7001 }]
    }
  ]
});
```

同一应用包含多个服务：

```ts
services: [
  { name: "identity", displayName: "Identity API", port: 7001 },
  { name: "infrastructure", displayName: "Infrastructure API", port: 7002 }
];
```

`project.name` 和 `service.name` 必须是 kebab-case ID，例如 `admin`、`file-service`。重复 ID、生成后 TypeScript 名称相同、非法 namespace 或 alias 都会在读取或写入产物前失败。

选择边界：

| 情况                       | 建议                                    |
| -------------------------- | --------------------------------------- |
| 同一应用、同一认证生命周期 | 一个 project，多个 service              |
| 服务地址不同，但认证一致   | 同一 project，覆盖 service `baseURL`    |
| 认证生命周期或协议完全不同 | 拆成不同 project                        |
| 只是 schema 同名           | 保持 service 隔离，不要为了名字强行合并 |

## 下载、生成和检查

```bash
pnpm download-swagger
pnpm generate:api portal
pnpm run generate:api -- --check
```

`--check` 完全只读：它在内存中准备预期产物并与正式目录比较；无差异返回 0，有漂移返回非 0 并列出文件。未知参数也会失败。

正式生成采用 project 级事务替换：所有 service、类型和 manifest 先准备成功，再替换旧目录。中断事务会在下一次生成前恢复；已移除 service 的旧文件随目录替换一起清理。

```text
src/api/gen/portal/
├── index.ts
├── api-types.ts
├── manifest.json
└── types/
    ├── identity.ts
    └── infrastructure.ts
```

`manifest.json` 记录生成器、TypeScript、openapi-typescript、esbuild 版本以及每个规范化 OpenAPI 文档的 hash，不记录当前时间，因此相同输入产生相同输出。

## 无歧义地访问类型

每个 service 的原始类型始终保留在独立文件：

```ts
import type { components as IdentityComponents } from "./gen/portal/types/identity.js";
```

`api-types.ts` 提供 canonical API：

```ts
import type { SchemaOf } from "./gen/portal/api-types.js";

type IdentityUser = SchemaOf<"identity", "Sample.Identity.UserDto">;
type InfrastructureUser = SchemaOf<"infrastructure", "Sample.Infrastructure.UserDto">;
```

多 service 默认不生成 `AllSchemas`。短 alias 或 namespace 只是便利导出；发生冲突时生成器直接列出两个 service 和 full schema name，不静默跳过或自动改名。

需要固定公开名时在 project 上显式配置：

```ts
typeExports: {
  namespaces: [
    { service: "infrastructure", match: "Sample.Infrastructure.", namespace: "Infrastructure" }
  ],
  aliases: [
    {
      service: "identity",
      schema: "Sample.Identity.UserDto",
      exportAs: "IdentityUser"
    }
  ]
}
```

短期兼容旧 `AllSchemas` 时可设置 `compatibility.legacyAllSchemas: true`，但仅在所有 service 的 full schema name 全局唯一时允许生成，并带有 deprecated 标记。新代码不要依赖它。

## 初始化生成客户端

旧的平铺配置仍然可用：

```ts
const api = createPortalClient({
  baseURL: env.API_URL,
  authService,
  middleware: [commonMiddleware]
});
```

多地址使用分层配置：

```ts
const api = createPortalClient({
  defaults: {
    baseURL: env.API_GATEWAY_URL,
    authService,
    middleware: [commonMiddleware],
    maxRetries: 2,
    retryDelayMs,
    logger
  },
  services: {
    infrastructure: {
      baseURL: env.INFRASTRUCTURE_API_URL,
      middleware: [infrastructureMiddleware]
    }
  }
});
```

规则固定为 `service override > defaults`，且只有值不为 `undefined` 的字段才覆盖。数组不自动拼接；service 提供 `middleware` 时是整体替换。第一阶段 `validateStatus` 和 `resolveErrorMessage` 保持 project defaults 级。

生成客户端直接复用 Core `NetConfig`，不会遗漏 `fetch`、超时、重试、`retryDelayMs` 或 `logger`。

## 枚举与业务 hooks

标准 OpenAPI 枚举默认由 openapi-typescript 生成 literal union。需要运行时常量时显式启用：

```ts
import { createRuntimeEnumHooks } from "@xapiforge/genapi";

{
  name: "infrastructure",
  displayName: "Infrastructure API",
  port: 7002,
  hooks: createRuntimeEnumHooks({
    metadata: {
      "Sample.AccessMode": { isFlags: true }
    }
  })
}
```

helper 只处理标准 `enum` + `x-enum-varnames`，可选读取 `x-enum-labels`。`isFlags` 会让 API 字段保持 `number`，runtime map 仍只列出声明值，组合值由业务代码使用位运算。

非标准历史格式必须先由业务 `preprocessSwagger` 规范化。可复制示例位于 `examples/demo-app/hooks/legacy-enum.ts`；它只挂在 demo 的 legacy service，不进入通用默认链路。详见[枚举](./enums.md)和 [genapi Hooks](./genapi-hooks.md)。

## CI 建议

```bash
pnpm run generate:api -- --check
pnpm typecheck
```

升级 `openapi-typescript`、TypeScript 或 esbuild 时应单独提交锁文件与生成 diff，并运行完整消费者编译。仓库维护命令见[维护入口](../internals/maintenance.md)。
