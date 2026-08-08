# genapi v2 破坏性迁移

v2 不提供兼容开关。迁移时一次性替换配置和类型导入，然后用真实 OpenAPI、类型检查和 `--check` 固化结果。

## 1. 把 URL 片段改成 source

旧配置通过 project/service 上的 host、port、path 拼接 URL。v2 为每个 service 写完整来源：

```ts
services: [
  {
    name: "identity",
    displayName: "Identity",
    source: { url: "https://identity.example.test/swagger/v1/swagger.json" }
  },
  {
    name: "fill-center",
    displayName: "Fill Center",
    source: { file: "tmp/dcenter/FillCenter.json" }
  }
];
```

service ID 不需要等于本地文件名。URL source 的离线缓存仍固定为：

```text
outputDir/<project>/<service>.json
```

已移除字段会被运行时校验明确拒绝，避免 JavaScript 配置静默继续运行。

## 2. 把平铺类型改成 service namespace

默认导出从平铺短名改为：

```ts
import type { IdentitySchemas } from "./api-types.js";

type User = IdentitySchemas.UserDto;
```

无论有多少 service 拥有 `UserDto`，它们都处于不同外层 namespace，不需要为重复短名维护别名。

如果整个 project 的短名天然唯一，并明确接受“未来发生碰撞就停止生成”，可以选择严格平铺：

```ts
const typeExports = { strategy: "flat-strict" as const };
```

这会生成 project 顶层 `UserDto`。它是 v2 的正式策略，不会为兼容旧输出而跳过、覆盖或自动改名。

如果业务不需要便利类型：

```ts
const typeExports = { strategy: "canonical-only" as const };
```

并直接使用：

```ts
type User = SchemaOf<"identity", "Company.Identity.UserDto">;
```

## 3. 把前缀规则下移到 project

前缀 namespace 写在对应 project 的 `typeExports.namespaces`。默认策略下位于 service namespace 内：

```ts
const typeExports = {
  namespaces: [
    {
      service: "fill-center",
      match: "Company.Infrastructure.",
      namespace: "Infrastructure"
    }
  ]
};
```

业务路径为 `FillCenterSchemas.Infrastructure.XxxDto`。

若 strategy 是 `flat-strict`，同一规则位于 project 顶层，业务路径为 `Infrastructure.XxxDto`。`canonical-only` 不允许配置前缀规则。

## 4. 只给真正的同 service 冲突写 alias

只有同一 service、同一内层 namespace 中两个 full schema name 产生相同短名时才需要：

```ts
const typeExports = {
  aliases: [
    {
      service: "identity",
      schema: "First.UserDto",
      exportAs: "FirstUserDto"
    }
  ]
};
```

生成器不会自动改名；缺失或重复规则会在写盘前失败。

## 5. 验证迁移

```bash
pnpm download-swagger
pnpm generate:api all
pnpm typecheck
pnpm build
pnpm exec xapiforge all --check
```

重点检查：

- 未修改 service 的 `types/<service>.ts` 没有意外漂移；
- 业务导入均符合选定的 `service-namespace`、`flat-strict` 或 `canonical-only` 策略；
- 重复 schema 没有跨 service 合并；
- 修改一个 service 后，其他 service 的类型文件保持字节级不变；
- 正式生成完成后再删除旧生成目录。

版本控制中应把配置、业务导入和需要提交的生成产物放在同一次变更中。真实 Swagger 验证目录可以保持在 `tmp/`，不要提交真实业务文档。
