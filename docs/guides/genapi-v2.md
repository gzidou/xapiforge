# genapi v2：多服务、稳定类型与明确来源

genapi v2 是破坏性版本，不保留旧的 Swagger URL 片段配置或旧类型导出。目标是让 OpenAPI 来源、service 身份和公开类型身份彼此独立，并在真实多微服务项目中保持可预测。

## 完整配置

```ts
import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  timeoutMs: 15_000,
  maxSwaggerBytes: 64 * 1024 * 1024,
  outputDir: "swagger",
  genOutputDir: "src/api/gen",
  mode: "online",
  projects: [
    {
      name: "dcenter",
      displayName: "Dcenter",
      services: [
        {
          name: "identity",
          displayName: "Identity",
          source: { url: "https://identity.example.test/openapi.json" }
        },
        {
          name: "fill-center",
          displayName: "Fill Center",
          source: { file: "tmp/dcenter/FillCenter.json" }
        }
      ],
      typeExports: {
        strategy: "service-namespace",
        namespaces: [
          {
            service: "fill-center",
            match: "Company.Infrastructure.",
            namespace: "Infrastructure"
          }
        ],
        aliases: [
          {
            service: "identity",
            schema: "Company.Identity.UserDto",
            exportAs: "UserDto"
          }
        ]
      }
    }
  ]
});
```

## source：来源不是身份

每个 service 必须配置且只能配置一种来源：

```ts
const localSource = { file: "tmp/dcenter/OriginalBackendName.json" };
// 或
const remoteSource = { url: "https://api.example.test/openapi.json" };
```

- `service.name` 是稳定身份，决定生成文件名、客户端 key 和类型 namespace。
- `source.file` 是磁盘位置；相对路径以运行 CLI 的项目根目录为基准。
- 程序化调用 `generate/generateMany` 时，可用 `configDirectory` 明确指定配置目录；省略时仍以当前工作目录为基准。
- `source.url` 是完整 HTTP(S) URL，不再拼接 host、port 或 path。
- 修改文件名、目录或 URL，不会改变 service/type 身份。

`xapiforge-fetch` 的行为：

- `source.file`：直接校验 JSON，不复制文件。
- online 的 `source.url`：下载到 `outputDir/<project>/<service>.json`。
- offline 的 `source.url`：读取上述缓存，不访问网络。
- `--dry-run`：本地来源仍校验，远程来源只打印 URL 和缓存路径，不发请求、不写缓存；常见 token/signature/key 类 query 值会在日志中遮盖，请求本身仍使用原 URL。
- `--only` 缺值、空值或包含未知 project 时直接失败，不会退化成全量下载或忽略拼写错误。
- 网络错误、响应体读取失败与 HTTP 5xx 默认重试一次；单次 `timeoutMs` 覆盖响应头和完整 JSON body。4xx、错误 Content-Type、超出大小限制或非法 JSON 不重试。
- `maxSwaggerBytes` 可选，默认 64 MiB，同时约束 URL 解压后响应、离线缓存、本地 `source.file` 和生成阶段输入；服务端缺少或伪造 `Content-Length` 时仍按实际流式字节数停止。
- 下载缓存以同目录临时文件加 rename 替换，失败不会留下半个 JSON。
- UTF-8 BOM 可被本地文件和远程 JSON 接受；online 下载不得覆盖任何 project 明确配置的 `source.file`。

生成前还会拒绝位于 project 输出目录内的 Swagger 输入，包括其它 project 引用的文件，避免事务替换生成目录时误删输入。

引用校验会区分 OpenAPI 语义对象和任意 JSON 数据：schema、response、PathItem 等位置只允许可解析的内部 `$ref`；`example`、`default`、Example Object 的 `value` 和 `x-*` 扩展内恰好叫 `$ref` 的业务字段按普通数据处理。生成器会为 `openapi-typescript` 建立隔离安全视图，避免其 Redocly bundler 误解析这些业务字段，权威规范化文档不会被改写。

## schema 的 canonical 身份

唯一权威身份是：

```text
project ID + service ID + full schema name
```

同名 schema 只要属于不同 service，就不会合并，也不会冲突：

```ts
type IdentityUser = SchemaOf<"identity", "Shared.UserDto">;
type InfrastructureUser = SchemaOf<"infrastructure", "Shared.UserDto">;
```

所有项目都会生成：

```ts
export interface SchemasByService {
  identity: IdentityComponents["schemas"];
  infrastructure: InfrastructureComponents["schemas"];
}

export type SchemaOf<Service extends keyof SchemasByService, Name extends keyof SchemasByService[Service]> = SchemasByService[Service][Name];
```

v2 不生成 `AllSchemas`，也不会把多个 service 的 schema 交叉合并。三种导出策略都保留这组 canonical API；差别只在是否额外生成便利短名。

## 三种导出策略

| strategy                    | 便利名称位置          | 短名碰撞范围            | 前缀 namespace         |
| --------------------------- | --------------------- | ----------------------- | ---------------------- |
| `service-namespace`（默认） | `<Service>Schemas` 内 | 单个 service 的同一层级 | service namespace 内层 |
| `flat-strict`               | project 顶层          | 整个 project 的同一层级 | project 顶层           |
| `canonical-only`            | 不生成                | 无便利短名              | 禁止配置               |

`flat-strict` 是明确选择的严格平铺模式，不是旧版兼容开关。只要自动短名、显式 alias、prefix namespace 或 canonical 名称在同一作用域冲突，生成就失败；生成器不会按出现顺序保留一个。

## 默认 service namespace

默认策略是 `service-namespace`。每个 service 自动生成一个稳定外层 namespace，名称只由 service ID 推导：

```ts
export namespace IdentitySchemas {
  export type UserDto = SchemaOf<"identity", "Shared.UserDto">;
}

export namespace InfrastructureSchemas {
  export type UserDto = SchemaOf<"infrastructure", "Shared.UserDto">;
}
```

业务侧使用：

```ts
import type { IdentitySchemas, InfrastructureSchemas } from "./api-types.js";

const identity: IdentitySchemas.UserDto = { id: "user-1" };
const infrastructure: InfrastructureSchemas.UserDto = { id: 1 };
```

因此，不同 service 中重复的 `UserDto` 不要求维护显式别名。

## 前缀 namespace 放在哪里

前缀规则的落点由 strategy 决定。默认 `service-namespace` 下，它位于 service namespace 内：

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

生成：

```ts
export namespace FillCenterSchemas {
  export namespace Infrastructure {
    export type OrganizationUnitDto = SchemaOf<"fill-center", "Company.Infrastructure.OrganizationUnitDto">;
  }
}
```

规则匹配不依赖数组顺序：

1. service 专属规则优先于 project 通用规则；
2. 同一优先级选择最长前缀；
3. 仍等价时按稳定字典序决定。

重新排列配置不会移动既有类型。

`flat-strict` 下，同一条规则生成 project 顶层 namespace：

```ts
const typeExports = {
  strategy: "flat-strict" as const,
  namespaces: [{ service: "catalog", match: "Company.Catalog.", namespace: "Catalog" }]
};
```

```ts
export namespace Catalog {
  export type ProductDto = SchemaOf<"catalog", "Company.Catalog.ProductDto">;
}

export type InvoiceDto = SchemaOf<"billing", "Company.Billing.InvoiceDto">;
```

此模式适合确认整个 project 的短名天然唯一、并希望保持简短 import 的项目。一旦后来新增 schema 造成同作用域碰撞，生成会明确失败，要求业务选择显式 alias；它不会悄悄改变已有类型指向。

## canonical-only

只需要无歧义的底层入口时：

```ts
const typeExports = { strategy: "canonical-only" as const };
```

此模式只输出 `SchemasByService`、`ServiceName` 和 `SchemaOf`，不输出任何便利 namespace。它不能同时配置 `namespaces` 或 `aliases`。

## 类型稳定性合同

genapi 保证以下变化不改变未受影响 identity 的访问路径：

- service 配置顺序变化；
- OpenAPI JSON 对象 key 顺序变化；
- `source.file` 改名或移动；
- `source.file` 与等价 `source.url` 缓存之间切换；
- 其他 service 增加、删除或修改 schema；
- 同一 service 中增加、删除或修改一个不在目标 schema 依赖闭包内的 schema。

稳定性边界：

- 修改 service ID 会改变 namespace、客户端 key 和文件名，这是显式破坏。
- 修改 full schema name 会改变 canonical identity，这是显式破坏。
- 修改目标 schema 本身，或修改它通过 `$ref` 依赖的 schema，目标类型必须变化。
- project 级集合类型（例如 `ServiceName`）会随 service 集合变化；已有成员的字面量和值不会被重命名。
- 显式修改 `typeExports.namespaces` 或 `aliases` 是主动修改公开便利路径。

生成器会递归排序 JSON 对象 key、保留数组顺序，并按稳定 service/schema 顺序渲染。冲突会在正式写盘前失败；不会按出现顺序静默跳过，也不会自动追加后缀。

## 验证

```bash
pnpm download-swagger
pnpm generate:api dcenter
pnpm generate:api dcenter -- --check
```

`--check` 只比较 staging 与正式产物，不写正式目录。生成采用整 project 事务替换；任何 service、hook、类型或 alias 失败时，旧产物保持不变。

示例网页必须通过开发服务器访问：

```bash
pnpm --filter '@xapiforge/example-demo-app' dev
```

不要双击 `index.html` 以 `file://` 打开；ES module 会被浏览器的同源策略阻止。
