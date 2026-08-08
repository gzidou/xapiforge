# 多后端与非规范 OpenAPI 接入

本文面向真正负责接入的人：一个前端项目同时面对多个微服务，OpenAPI 文件名、下载地址、运行时地址和 service ID 不一致，并且部分后端文档不完全规范。

目标不是“生成过一次”，而是得到一条可重复、可审查的接入链路：

```text
确认真实协议
  → 固定 service 身份与 OpenAPI 来源
  → 原样生成一次并记录问题
  → 只在业务侧保守规范化已确认的问题
  → 初始化真实运行时地址
  → 编译一个实际调用
  → 固化生成与 --check
```

## 先收集证据

不要从复制示例配置开始。先为每个后端确认下表；不知道的项应向后端维护者确认，不要猜。

| 信息                     | 用途                                       | 常见误区                           |
| ------------------------ | ------------------------------------------ | ---------------------------------- |
| 稳定 service ID          | 生成文件、类型身份、namespace 和客户端属性 | 直接使用会变化的 Swagger 文件名    |
| OpenAPI URL 或本地文件   | 生成阶段读取 schema                        | 把运行时 API 地址当成 Swagger 地址 |
| 运行时 `baseURL`         | 页面真正发请求                             | 从 `source.url` 自动推导           |
| 实际请求/响应样本        | 判断 OpenAPI 是否与线上序列化一致          | 只看 Swagger 就修改类型            |
| 鉴权和刷新协议           | 初始化 `AuthService`                       | 复制示例 OAuth 路径和字段          |
| 业务 envelope            | 决定是否需要 middleware                    | 用生成 hook 解包运行时响应         |
| OpenAPI 维护人和快照策略 | 处理后端变更与 CI                          | 每次构建读取不可追溯的实时文档     |

至少用一个实际响应确认高风险字段：枚举、ID、日期、可空字段、分页结构和错误结构。OpenAPI 与实际响应冲突时，先确认后端契约；hook 只能修正已经查明的问题，不能证明猜测是正确的。

## 安装和脚本

沿用接入项目已有的包管理器。以下示例使用 pnpm 和浏览器 adapter：

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser
pnpm add -D @xapiforge/genapi
```

`package.json`：

```json
{
  "scripts": {
    "download-swagger": "xapiforge-fetch",
    "generate:api": "xapiforge",
    "check:api": "xapiforge all --check"
  }
}
```

不要全局安装 CLI，也不要直接依赖 `openapi-typescript` 或 `openapi-fetch` 来修补生成结果。

## 给来源和身份分别命名

一个 project 可以混用 URL 和本地文件。二者统一放在 `source` 字段中，但每个 service 必须且只能选择一种：

```ts
import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  timeoutMs: 15_000,
  maxSwaggerBytes: 64 * 1024 * 1024,
  outputDir: "openapi-cache",
  genOutputDir: "src/api/gen",
  mode: "online",
  projects: [
    {
      name: "partner-portal",
      displayName: "Partner Portal",
      services: [
        {
          name: "catalog",
          displayName: "Catalog",
          source: { url: "https://catalog.example.test/openapi.json" }
        },
        {
          name: "legacy-orders",
          displayName: "Legacy Orders",
          source: { file: "openapi/Vendor Orders Export.json" }
        }
      ]
    }
  ]
});
```

这里有三组不同概念：

| 概念               | 示例                          | 是否参与公开身份       |
| ------------------ | ----------------------------- | ---------------------- |
| service ID         | `legacy-orders`               | 是，必须稳定           |
| 本地文件或下载 URL | `Vendor Orders Export.json`   | 否，可以移动或改名     |
| 运行时 `baseURL`   | `https://orders.example.test` | 否，在创建客户端时配置 |

project 和 service ID 必须匹配 `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`。不要把环境名、端口、版本号或文件扩展名放进 ID；修改 ID 是公开类型和客户端 API 的破坏性变更。

`source.url` 在 online 模式下载到：

```text
openapi-cache/partner-portal/catalog.json
```

`source.file` 始终直接读取配置路径，不要求文件名等于 service ID，也不会被复制到缓存目录。

### online、offline 和 CI

- `online`：`xapiforge-fetch` 下载 URL source；file source 只做本地校验。
- `offline`：URL source 读取标准缓存；file source 仍读取原路径，全程不访问网络。
- `--dry-run`：校验 file source，并打印 URL source 的下载计划，不下载。

需要可复现构建时，推荐提交审核过的 URL 缓存或改用 `source.file`，CI 使用 offline 配置。不要让同一个前端提交在不同时间无审查地读取后端最新文档。

OpenAPI URL 不得包含用户名、密码或 fragment。即使 token 类 query 参数在日志中会遮盖，也不应把凭据写进将提交的配置文件。

## 先原样生成，再决定是否写 hook

第一次接入先不加修复性 hook：

```bash
pnpm exec xapiforge list
pnpm run download-swagger --dry-run
pnpm download-swagger
pnpm generate:api partner-portal
```

然后检查：

1. 每个 service 的 path 数量是否合理；
2. 生成的请求方法、参数和响应是否与实际样本一致；
3. 同名 schema 是否只是跨 service 重复；
4. enum 值类型是否与后端真实 JSON 一致；
5. 是否存在系统内部 path、无效 `$ref`、外部 `$ref` 或明显错误的 schema；
6. `source.url` 和运行时 `baseURL` 是否被错误地当成同一个地址。

生成器会拒绝非法 OpenAPI 3.x、无法解析的语义 `$ref`、外部 `$ref` 和会造成不稳定导出的名称冲突；启用 runtime enum helper 后还会严格校验 enum 值类型、varname 和 metadata。没有 helper 的普通 literal union 仍必须由接入者对照真实 JSON，不能把“生成成功”当成后端 enum 符合规范。不要用 `any`、强制类型断言或直接编辑生成文件绕开失败。

## 问题应该在哪一层处理

| 问题                                | 正确位置                                         | 不应采用的处理                        |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------- |
| 不规范 enum、错误 schema、内部 path | service `transformSwagger` / `preprocessSwagger` | 修改生成文件                          |
| enum label、颜色、图标、Options     | `createRuntimeEnumHooks` metadata                | 页面散落魔法映射                      |
| 跨 service 同名 schema              | 默认 service namespace                           | 合并 Swagger 或维护大量别名           |
| 同一 service 的短名冲突             | 精确 `typeExports.aliases`                       | 按顺序跳过或自动加后缀                |
| 业务 `{ code, data }` envelope      | runtime middleware                               | `transformTypes`                      |
| 不同 service 的 API 地址            | client `defaults/services`                       | 从 Swagger URL 推导                   |
| CORS、证书、代理                    | 运行环境或网络层                                 | 改 OpenAPI 类型                       |
| 超过 JS 安全整数的数字 ID           | 后端改为字符串序列化并同步 OpenAPI               | 只在 hook 中把 `number` 写成 `string` |

特别注意：如果后端实际发送的是超过 `Number.MAX_SAFE_INTEGER` 的 JSON number，浏览器解析时精度已经丢失。只改生成类型无法修复数据，必须让后端按字符串发送。

## 保守处理 legacy enum

下面的后端把 integer enum 错写成字符串：

```json
{
  "type": "integer",
  "enum": ["Created(新建)=0", "Paid(已支付)=1"]
}
```

业务 normalizer 应当只在整个 enum 都符合已确认格式时转换；任意一项无法识别就原样保留，让生成或验证暴露问题。不要部分转换。

```ts
import { createRuntimeEnumHooks, type GenapiHooks, type RuntimeEnumMetadata } from "@xapiforge/genapi";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacyEnum(value: unknown) {
  if (typeof value !== "string") return undefined;
  const suffix = /=(-?\d+)$/.exec(value.trim());
  if (!suffix || suffix.index === undefined) return undefined;
  const prefix = value.trim().slice(0, suffix.index).trim();
  const open = prefix.indexOf("(");
  const name = (open < 0 ? prefix : prefix.slice(0, open)).trim();
  const label = open < 0 || !prefix.endsWith(")") ? "" : prefix.slice(open + 1, -1).trim();
  const numericValue = Number(suffix[1]);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || !label || !Number.isSafeInteger(numericValue)) {
    return undefined;
  }
  return { name, label, value: numericValue };
}

function normalizeLegacyOrders(input: unknown): unknown {
  const document = structuredClone(input);
  if (!isRecord(document) || !isRecord(document.paths)) return document;

  for (const path of Object.keys(document.paths)) {
    if (path.startsWith("/internal-docs/")) delete document.paths[path];
  }

  if (!isRecord(document.components) || !isRecord(document.components.schemas)) return document;
  for (const schema of Object.values(document.components.schemas)) {
    if (!isRecord(schema) || schema.type !== "integer" || !Array.isArray(schema.enum)) continue;
    const parsed = schema.enum.map(parseLegacyEnum);
    if (parsed.length === 0 || parsed.some(item => item === undefined)) continue;
    const values = parsed.filter(item => item !== undefined);
    schema.enum = values.map(item => item.value);
    schema["x-enum-varnames"] = values.map(item => item.name);
    schema["x-enum-labels"] = values.map(item => item.label);
  }
  return document;
}

const orderMetadata: Readonly<Record<string, RuntimeEnumMetadata>> = {
  "Vendor.Legacy.OrderStatus": {
    overrideLabels: { 0: "待处理", 1: "已付款" },
    extensions: {
      tagType: { 0: "warning", 1: "success" },
      icon: { 0: "Clock", 1: "Check" }
    }
  }
};

export function createLegacyOrderHooks(): GenapiHooks {
  return createRuntimeEnumHooks({
    preprocessSwagger: input => Promise.resolve(normalizeLegacyOrders(input)),
    metadata: orderMetadata
  });
}
```

把 hook 配在目标 service 上：

```ts
{
  name: "legacy-orders",
  displayName: "Legacy Orders",
  source: { file: "openapi/Vendor Orders Export.json" },
  hooks: createLegacyOrderHooks()
}
```

metadata 必须放在真正包含该 full schema name 的 service hook 上。不要给所有 service 套一份包含彼此 schema 的 metadata；不存在的 schema 会被严格判错，这是为了防止配置拼写错误静默失效。

`transformSwagger` 返回的新文档会成为唯一的 `normalizedDocument`。后续类型、path 统计、namespace、manifest 和 runtime enum 都读取它；`transformTypes` 不应重新读取原 Swagger。

## 选择稳定类型入口

多服务项目优先保留默认 `service-namespace`：

```ts
typeExports: {
  namespaces: [
    {
      service: "catalog",
      match: "Acme.Catalog.Contracts.",
      namespace: "Contracts"
    },
    {
      service: "legacy-orders",
      match: "Vendor.Legacy.",
      namespace: "Legacy"
    }
  ];
}
```

业务使用：

```ts
import { CatalogSchemas, LegacyOrdersSchemas } from "./api/gen/partner-portal/api-types.js";

type Product = CatalogSchemas.Contracts.ProductDto;
type Status = LegacyOrdersSchemas.Legacy.OrderStatus;

const paid: Status = LegacyOrdersSchemas.Legacy.OrderStatus.Paid;
const options = LegacyOrdersSchemas.Legacy.OrderStatusOptions;
const tagType = LegacyOrdersSchemas.Legacy.OrderStatusTagType[paid];
```

跨 service 都叫 `Shared.Result` 不会冲突，它们分别属于 `CatalogSchemas.Result` 和 `LegacyOrdersSchemas.Result`。只有同一 service、同一 namespace 内出现真正的短名冲突时，才配置一条精确 alias。

## 初始化多运行时客户端

Swagger 下载地址不参与运行时请求。运行时地址在创建客户端时单独配置：

```ts
import { createPartnerPortalClient } from "./api/gen/partner-portal/index.js";

export const api = createPartnerPortalClient({
  defaults: {
    baseURL: "https://catalog.example.test",
    authService,
    middleware: [businessEnvelopeMiddleware]
  },
  services: {
    "legacy-orders": {
      baseURL: "https://orders.example.test",
      middleware: [legacyEnvelopeMiddleware]
    }
  }
});
```

两种 service 名称不要混淆：

- 配置、canonical 类型和 `services` override 使用原始 ID：`"legacy-orders"`；
- 生成客户端属性是合法标识符：`api.legacy_orders`；
- service namespace 是 PascalCase：`LegacyOrdersSchemas`；
- service 类型文件仍是 `types/legacy-orders.ts`。

override 只替换明确提供且不为 `undefined` 的字段；middleware 数组是整体替换，不会自动与 defaults 拼接。

## 编译一个真实调用

不要只检查生成文件存在。至少写一个只读调用，让 TypeScript 验证 service、method、path、path params 和返回值：

```ts
const { data, response } = await api.catalog.GET("/v1/products/{id}", {
  params: { path: { id: "product-1" } }
});

console.log(response.status, data);

const orders = await api.legacy_orders.GET("/v1/orders", {
  params: { query: { page: 1 } }
});
```

再通过允许的真实后端或 mock 观察至少一个请求。只有安装依赖或生成成功，不算完成接入。

## 固化验证

推荐顺序：

```bash
pnpm download-swagger
pnpm generate:api partner-portal
pnpm typecheck
pnpm build
pnpm check:api
```

`--check` 只比较 staging 和当前生成目录，不写正式产物；有漂移时返回非零。提交生成结果的团队应在 CI 直接运行它。构建时生成的团队应固定 OpenAPI 输入和包版本，并在构建前生成，不要把“刚生成后立即 check”当成后端变更审查。

每个业务 hook 还应有脱敏 fixture，至少验证：原文件未改变、无法识别的格式不被猜测、错误 metadata 会失败、相关类型/Options 可编译，以及改变一个 service 不会移动其它 service 的公开类型。

## 常见失败定位

| 现象                               | 优先检查                                                           |
| ---------------------------------- | ------------------------------------------------------------------ |
| `source.file` 不存在               | 路径是否相对运行 CLI 的配置目录，扩展名是否为 `.json`              |
| offline 缺少 URL 缓存              | 是否先 online 下载，缓存是否位于 `outputDir/project/service.json`  |
| `source` 配置失败                  | 是否同时写了 file/url，URL 是否完整且没有用户名、密码或 fragment   |
| enum 值类型不匹配                  | 实际 JSON 序列化值；只对完整可识别格式做 normalizer                |
| metadata schema 不存在             | metadata 是否放错 service，full schema name 是否完全一致           |
| alias/namespace 冲突               | 读取错误中的两个 service/full schema identity，写最小显式 alias    |
| 外部 `$ref` 被拒绝                 | 在受控流程中先 bundle 成自包含 OpenAPI；不要让生成阶段访问漂移依赖 |
| `api.legacy-orders` 语法错误       | kebab-case service 的客户端属性应使用下划线：`api.legacy_orders`   |
| 请求打到错误主机                   | 检查 client `defaults/services`，不要检查 `source.url`             |
| 浏览器 CORS、证书或 `file://` 错误 | 使用开发服务器，并在后端/代理/运行时网络层处理                     |

## 完成标准

- 每个 service 的 ID、来源、缓存策略和运行时地址都有明确记录；
- 非规范处理只存在于对应 service hook，并有脱敏 fixture；
- 业务代码使用稳定 namespace，没有跨 service 合并 schema；
- enum 类型、值、Options 和页面 metadata 来自同一 normalized document；
- 类型检查、生产构建和确定性检查通过；
- 至少一个真实或 mock 请求已观察；
- 未验证的凭据、CORS、证书、设备或后端环境依赖被明确列出。

继续阅读：[浏览器应用接入](./browser.md)、[genapi v2](../guides/genapi-v2.md)、[genapi Hooks](../guides/genapi-hooks.md)、[枚举生成](../guides/enums.md)和[非规范 Swagger 问题分类](../internals/swagger-pitfalls.md)。
