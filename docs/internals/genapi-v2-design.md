# genapi v2 设计基线

状态：已批准并进入实现。本文描述 v2 的当前合同；不再保留早期兼容方案。

## 1. 目标

genapi v2 面向真实多微服务 OpenAPI 项目，解决四个问题：

1. service ID 与 Swagger 文件名、URL 解耦；
2. 同名 schema 以 service 隔离，绝不错误合并；
3. 公开类型路径在无关后端变化下保持稳定；
4. 多 service 全部准备成功后再事务替换产物。

v2 是破坏性版本。当前没有需要保护的既有用户，因此不保留旧字段、旧导出或兼容开关。

## 2. 非目标

- 不在内核内修复特定后端框架的非标准 Swagger；业务通过 hooks 规范化。
- 不根据 schema 结构猜测两个不同 identity 是否“其实相同”。
- 不为碰撞自动加 service 前缀、数字后缀或按顺序跳过。
- 不把 Swagger 下载 URL 当成应用运行时 `baseURL`。
- 不承诺目标 schema 或其依赖发生真实语义变化时类型仍不变。

## 3. 权威身份

### 3.1 project 与 service

```text
project identity = project.name
service identity = project.name + service.name
```

`name` 必须是稳定 kebab-case 配置 ID。它参与：

- 生成目录；
- service 类型文件名；
- 客户端对象 key；
- service namespace；
- manifest service key。

`displayName` 只用于人类可读输出，不参与身份。

### 3.2 schema

```text
schema identity = project.name + service.name + full schema name
```

禁止只用短名或只用 full schema name 跨 service 合并。同名 schema 在不同 service 中可以有完全不同结构。

## 4. Swagger source

每个 service 必须声明：

```ts
source: { file: string } | { url: string }
```

选择对象而不是裸字符串，原因是：

- 不根据字符串形态猜测协议；
- TypeScript 可静态保证 file/url 互斥；
- 运行时可以拒绝未知字段和不合法 URL；
- 以后新增其他来源时仍保持可判别 union。

### 4.1 file

- 绝对路径直接使用；
- 相对路径以配置项目的 cwd 为基准；
- 生成器直接读取，不复制、不重命名；
- 文件位置不进入生成注释、manifest identity 或类型名称。

### 4.2 url

- 必须是完整 HTTP(S) URL；
- 禁止 URL 内嵌用户名或密码；
- online 下载到 `outputDir/<project>/<service>.json`；
- offline 从同一路径读取缓存；
- 下载使用同目录临时文件加 rename，避免半写缓存。

URL 只定位 OpenAPI 文档。生成客户端的运行时 `baseURL` 由应用初始化 `create<Project>Client` 时提供。

## 5. 配置合同

```ts
interface ServiceConfig {
  name: string;
  displayName: string;
  source: { file: string } | { url: string };
  hooks?: GenapiHooks;
}

interface ProjectConfig {
  name: string;
  displayName: string;
  services: ServiceConfig[];
  hooks?: GenapiHooks;
  typeExports?: ProjectTypeExportConfig;
}

type TypeExportStrategy = "service-namespace" | "flat-strict" | "canonical-only";

interface NamespaceRule {
  service?: string;
  match: string;
  namespace: string;
}

interface SchemaAliasRule {
  service: string;
  schema: string;
  exportAs: string;
  namespace?: string;
}

interface ProjectTypeExportConfig {
  strategy?: TypeExportStrategy;
  namespaces?: NamespaceRule[];
  aliases?: SchemaAliasRule[];
}

interface XApiForgeConfig {
  timeoutMs: number;
  maxSwaggerBytes?: number; // 默认 64 MiB
  outputDir: string;
  genOutputDir?: string;
  mode?: "online" | "offline";
  projects: ProjectConfig[];
  hooks?: GenapiHooks;
}
```

明确移除：

- root `defaultPath`；
- project/service `baseHost`；
- service `port`、`path`；
- root `namespacePrefixAliases`；
- `AllSchemas`；
- 所有 compatibility 配置。

即使 JavaScript 绕过 TypeScript，运行时校验也会拒绝这些已移除字段。

## 6. 单次规范化流水线

每个 service 只形成一份 normalized document：

```text
read source
  → JSON parse
  → raw OpenAPI 3.x validation
  → freeze originalDocument
  → structuredClone
  → transformSwagger
  → normalized OpenAPI 3.x validation
  → validate JSON values + canonicalize object keys
  → deep-freeze authoritative normalized document
  → internal $ref validation + PathItem reference index
  ├─ openapi-typescript isolated safe view
  ├─ endpoint metadata
  ├─ schema export inventory
  └─ canonical manifest hash
```

所有下游视图必须复用同一份深度冻结的 document，不能分别重新读取或分别跑 hook。`openapi-typescript` 的 Redocly bundler 会改写传入对象，还会把 `example`、`default`、vendor extension 等任意 JSON 数据里的 `$ref` 误当成语义引用。因此只给该第三方一个从 normalized document 派生的一次性安全视图：仅剔除 literal JSON 内的 `$ref`、`$dynamicRef`、`$recursiveRef`、`$anchor` key；schema、response、PathItem 等语义位置不变。这不是第二次规范化，endpoint、alias、manifest 和 hook context 仍读取权威冻结对象。

### 6.1 canonical 化

- 递归排序 JSON object key；
- 保留所有 array 顺序；
- 拒绝 `undefined`、`NaN`、`BigInt`、class instance 等非 JSON 值；
- 把 `__proto__` 等特殊名称保留为普通 JSON key；
- 拒绝循环引用；
- hash 基于 canonical JSON。

对象 key 顺序不属于 JSON/OpenAPI 语义。数组可能承载 enum、oneOf、parameters 等语义，因此不能排序。

## 7. 类型导出

### 7.1 canonical API

始终生成：

```ts
export interface SchemasByService {
  identity: IdentityComponents["schemas"];
}

export type ServiceName = keyof SchemasByService;

export type SchemaOf<Service extends ServiceName, Name extends keyof SchemasByService[Service]> = SchemasByService[Service][Name];
```

### 7.2 service-namespace

默认策略。外层 namespace 仅由稳定 service ID 推导：

```text
fill-center → FillCenterSchemas
```

每个 schema 的自动短名只在所属 service namespace 内参与碰撞检查。跨 service 同名无冲突。

### 7.3 flat-strict

显式选择的 project 顶层便利导出策略：

```text
Catalog.ProductDto
InvoiceDto
```

所有 service 在 project 作用域共同参与碰撞检查。任何同层短名、alias/namespace 同名，或与 `SchemaOf`、`SchemasByService`、`ServiceName`、内部 components import 名称冲突，均在写盘前失败。`flat-strict` 不按 service 自动加前缀，也不属于兼容模式。

### 7.4 prefix namespace

`projects[].typeExports.namespaces` 的层级由策略决定：

```text
service-namespace → FillCenterSchemas.Infrastructure.OrganizationUnitDto
flat-strict      → Infrastructure.OrganizationUnitDto
```

匹配顺序固定：

1. service 专属规则优先；
2. 最长前缀优先；
3. 稳定字典序兜底。

配置数组顺序不参与结果。

### 7.5 explicit alias

只用于确定的 `service + full schema name`：

```ts
{
  service: "identity",
  schema: "First.UserDto",
  exportAs: "FirstUserDto",
  namespace: "OptionalInnerNamespace"
}
```

`namespace` 在 `service-namespace` 下是 service 内层，在 `flat-strict` 下是 project 顶层。规则指向不存在的 service/schema、目标重复、alias 与 namespace 同名，均在写盘前失败。

### 7.6 canonical-only

只生成 canonical API，不生成便利 namespace。此模式不能配置 prefix namespace 或 alias。

## 8. 稳定性合同

### 8.1 保证稳定

以下变化不改变未受影响 identity 的公开访问路径：

- service 配置重排；
- schema JSON object key 重排；
- source 文件改名、移动或 URL 迁移；
- file 与等价 URL cache 切换；
- 其他 service 的 schema 增加、删除或类型变化；
- 同一 service 中、不属于目标 schema 依赖闭包的 schema 变化。

实现手段：

- source 不参与身份；
- service/schema 统一稳定排序；
- canonical document；
- service namespace 隔离；
- 不自动重命名；
- manifest 只记录 service key 与 normalized hash；
- 生成注释不包含 source 地址或时间戳。

### 8.2 必然变化

以下是显式破坏或真实语义变化：

- project/service ID 改名；
- full schema name 改名；
- schema 自身改变；
- schema 的 `$ref` 依赖改变；
- 主动修改 alias/namespace 配置；
- service 集合变化导致 project 集合类型增减成员。

稳定的含义是“未受影响的 identity 不被重命名、移动或错误重绑定”，不是把真实后端变化隐藏起来。

## 9. 客户端生成

每个 service 单独生成 `paths` 并单独调用 `createNet<Paths>`。不交叉合并 paths，避免多个 Swagger 复制公共 endpoint 时产生错误类型交集。

所有 service 共用同一个运行时地址时，可直接传 Core `NetConfig`。这是 v2 的简洁初始化形式，不是旧配置兼容开关。

运行时配置支持：

```ts
createDemoClient({
  defaults: {
    baseURL: "https://gateway.example.test",
    authService
  },
  services: {
    infrastructure: {
      baseURL: "https://infrastructure.example.test"
    }
  }
});
```

优先级固定为 `service override > project defaults`。这里的 baseURL 是业务请求地址，与 Swagger source 无关。

## 10. hooks

优先级是完整对象覆盖：

```text
service > project > root
```

service 写 `{}` 表示显式禁用继承。hook 后的 document 必须仍是 OpenAPI 3.x，且语义位置只允许可解析的内部 `$ref`。业务 example/default/value/vendor extension 是任意 JSON，其中同名 key 不参与引用校验。当前依赖会把语义位置的 `$dynamicRef`/`$recursiveRef` 静默降级为 `unknown`，因此内核明确拒绝这两种引用，而不是生成虚假的弱类型。业务特殊格式由业务 hook 处理，内核不包含 ABP、SpringBoot 或其他框架特判。

通用 runtime enum helper 在 `transformSwagger` 中把 override/append 合并进标准 enum 一次，并把 service 级运行时导出清单写入该 service 的 hook context。`transformTypes` 只读取冻结的 `normalizedDocument` 和创建 helper 时的 metadata 快照；`api-types.ts` 再按现有 service/prefix/alias 规则重导出 const、Options、Labels 和 extensions。禁止重新读取 `swaggerPath` 或使用跨 service 全局缓存。

## 11. 原子生成

```text
prepare every service in memory
  → render every project into staging
  → compare/check
  → acquire root lock
  → persist transaction state
  → rename old output to backup
  → rename staging to output
  → remove backup and transaction state
```

任何准备失败都不创建正式输出。提交失败会自动恢复 backup；若进程中断，下次生成先恢复 transaction state。

`--check` 只比较，不写正式输出。

## 12. manifest

```json
{
  "formatVersion": 2,
  "generator": "@xapiforge/genapi",
  "generatorVersion": "...",
  "openapiTypescriptVersion": "...",
  "typescriptVersion": "...",
  "esbuildVersion": "...",
  "project": "demo",
  "services": {
    "base": {
      "normalizedDocumentHash": "sha256:..."
    }
  }
}
```

不写生成时间、绝对路径或 source URL，保证相同规范化输入得到相同产物。

## 13. 验证矩阵

逐项实现与证据见 [genapi v2 严格 review 矩阵](./genapi-v2-review-matrix.md)。

自动回归必须覆盖：

- file 名与 service ID 不同；
- file 移动、file/url cache 切换不漂移；
- service 配置重排不漂移；
- JSON object key 重排不漂移；
- 跨 service 同名 schema 保持异构；
- 同 service 同 namespace 短名碰撞失败；
- `flat-strict` 跨 service 碰撞失败且显式 alias 可解除；
- alias/namespace 与 canonical 顶层名称碰撞失败；
- prefix 规则重排不漂移；
- 三种导出策略均可编译；
- URL online、offline cache、dry-run 与 file 直读分支；
- 无关 schema 增删改不破坏稳定 import；
- external `$ref` 在写盘前失败；
- `--check` 只读；
- 多 project 全准备后才写；
- stale file 清理；
- transaction 中断恢复；
- 独立 consumer CLI；
- 真实 `tmp/dcenter` 多微服务生成与 typecheck。

真实业务 Swagger、生成验证项目和临时包放在根目录 `tmp/`。该目录必须保持 Git ignored，不得提交。

## 14. 已知边界

- OpenAPI 数组顺序变化可能改变输出；数组可能有语义，生成器不会擅自排序。
- external `$ref` 暂不支持。
- `$dynamicRef` / `$recursiveRef` 暂不支持；必须先由业务 hook 规范化为普通内部 `$ref`。
- 单个 Swagger 默认最多 64 MiB；确有更大规范时必须显式提高 `maxSwaggerBytes`，避免远程或本地异常输入无上限占用内存。
- hook 代码本身必须确定；hook 若注入时间、随机数或环境差异，生成器无法替它保证稳定。
- openapi-typescript 版本变化可能改变格式或类型；manifest 固定记录版本，升级必须作为显式变更评审。
