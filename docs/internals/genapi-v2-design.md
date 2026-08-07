# @xapiforge/genapi v2 设计与开发基线

> **状态**：开发基线（2026-08-06）
>
> **适用范围**：`packages/genapi`、生成产物、`xapiforge.config.ts`、`examples/demo-app`、genapi 测试与接入文档
>
> **目标**：让同一套生成器稳定处理单服务、多服务、多后端地址、同名但结构不同的 schema、命名空间、标准枚举和非标准 Swagger 扩展。
>
> **代码基线**：commit `7d98cb53e2de`，`@xapiforge/genapi` `0.1.4`；本地解析到 `openapi-typescript` `7.13.0`、TypeScript `5.9.3`、esbuild `0.28.1`。
>
> **版本说明**：本文中的“v2”表示第二代生成契约和实现，不预先等同于 npm `2.0.0`。最终发布版本在兼容性改造完成后决定。

本文是 genapi v2 的设计和验收基线。开发过程中如果实现与本文冲突，应先更新设计决策和测试，再修改实现，避免代码、生成产物和文档各自形成不同规则。

相关文档：

- [浏览器接入](../getting-started/browser.md)
- [genapi Hooks 设计](../guides/genapi-hooks.md)
- [枚举类型生成方案](../guides/enums.md)
- [Swagger 已知问题](./swagger-pitfalls.md)
- [验证指南](./validation.md)

---

## 1. 背景

现有 genapi 已经具备一条可用的主链路：

1. 一个 project 可以配置多个 service。
2. 每个 service 的 OpenAPI 文档独立生成 `types/<service>.ts`。
3. 每个 service 使用自己的 `paths` 类型创建 `createNet<paths>` client。
4. `api-types.ts` 提供 schema 短名和可选 namespace，方便业务代码导入。
5. `transformSwagger` 和 `transformTypes` 可以处理非标准后端 Swagger。

这套结构在单服务、schema 名称没有冲突时工作正常。随着多微服务和不同后端协议接入，以下问题开始影响类型正确性和生成稳定性：

- 多个 service 的同名 schema 被交叉合并或静默丢弃。
- hook 转换后的类型和 `api-types.ts` 使用的 schema 来源不一致。
- 所有 service 共用一个运行时 `baseURL` 和一份网络配置。
- 生成过程不是原子的，失败后可能留下新旧混合产物。
- 输出包含生成时间，依赖版本使用范围声明，相同输入不一定得到相同文件。
- 当前 demo 和测试没有覆盖命名空间、枚举、schema 冲突和异构服务。

v2 不以“支持更多 Swagger 字段”为唯一目标。首要任务是明确生成契约，让相同输入得到确定输出，让不同服务的数据结构始终保持隔离，并在无法安全推导时明确失败。

---

## 2. 术语与边界

### 2.1 Project

Project 是一组生成产物的目录和 client 工厂边界：

```text
src/api/gen/<project>/
```

同一 project 下的 service 默认共享认证、middleware、fetch、重试等运行时策略，但允许覆盖服务地址和少量服务级配置。

认证生命周期、错误协议或部署生命周期完全不同的后端，优先拆成不同 project，不把所有后端勉强塞进一个 client 工厂。

### 2.2 Service

Service 对应一份独立 OpenAPI 文档和一个独立强类型 client：

```text
swagger/<project>/<service>.json
src/api/gen/<project>/types/<service>.ts
api.<service>.GET(...)
```

两个 service 即使存在相同 path 或相同 schema 名，也不代表它们具有相同语义。

### 2.3 Schema identity

schema 的唯一身份是：

```text
project + service + schema full name
```

例如：

```text
demo + identity + Sample.Identity.UserDto
demo + billing  + Sample.Identity.UserDto
```

即使 full name 相同，只要 service 不同，就必须视为两个独立类型。生成器不得根据名称自动判断它们可以共享或合并。

### 2.4 标准能力与业务扩展

- 标准 OpenAPI 的 path、parameter、request body、response、schema 和 enum 由 genapi 内核与 `openapi-typescript` 处理。
- 后端框架或历史系统产生的非标准形态通过 hooks 规范化。
- 内核不硬编码某个业务后端的枚举格式、envelope 或框架前缀。
- 可以提供框架无关、显式启用的通用 hook helper，但不能默认改变标准 OpenAPI 语义。

---

## 3. v2 目标

### 3.1 必须实现

1. **类型隔离**：不同 service 的 schema 永不隐式合并。
2. **稳定导出**：新增 service 或 schema 不应静默改变已有类型导出名称。
3. **单一数据源**：类型、alias、namespace、endpoint 元数据全部来自同一份 hook 后文档。
4. **明确失败**：配置、名称、alias 或 namespace 冲突必须在写正式产物前报错。
5. **原子生成**：生成全部成功后再替换旧目录，失败时旧产物保持完整。
6. **确定性输出**：相同配置、相同 Swagger、相同已解析工具链和受支持运行环境必须得到字节一致的产物，并在 manifest 中记录这条边界。
7. **多服务运行时**：同一 project 可以给 service 覆盖运行时地址；不同认证或协议可以拆成不同 project。
8. **标准枚举可用**：标准字符串和数字枚举有正确 literal union；可选生成运行时常量和 label。
9. **兼容迁移**：现有单服务接入方式和生成目录尽量保持不变。
10. **可验证**：提供 fixture、集成测试、消费者编译和 CI `--check`。

### 3.2 非目标

- 不自动把不同 service 的同名 DTO 识别为共享业务模型。
- 不在 v2 第一阶段重写 `openapi-fetch` 或 `@xapiforge/core` 请求模型。
- 不默认生成 TypeScript `enum`。
- 不把所有合法和非法 OpenAPI 情况放进一个超大 Swagger 文件。
- 不把开发环境 Swagger 下载地址固化成生产运行时地址。
- 不让 genapi 内核直接理解 ABP、SpringBoot、NestJS 等框架的业务约定。

---

## 4. 当前问题清单

### 4.0 已核对的代码证据

以下结论来自上述代码基线，不根据文件名或历史印象推断：

| 结论                                   | 当前实现证据                                                                                                                                                               | 直接影响                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 正式目录会在生成开始时被创建并逐个写入 | `generate()` 先创建 `outDir/types`，随后依次写 `types/<service>.ts`、`index.ts` 和 `api-types.ts`（`packages/genapi/src/index.ts:218-325`）                                | 中途失败会留下部分新产物                            |
| hook 前后文档来源不一致                | `openapi-typescript` 使用 `applyTransformSwagger()` 的结果；endpoint 统计和 `renderApiTypes()` 又读取原始 Swagger（`packages/genapi/src/index.ts:267-323`）                | alias、统计与真实 client 类型可能不一致             |
| 缺失 Swagger 会被跳过                  | service 文件不存在时只 `console.warn` 后 `continue`（`packages/genapi/src/index.ts:251-256`）                                                                              | 旧 service 文件可能继续存在                         |
| 多 service schema 会被交叉合并         | `AllSchemas` 使用 `UnionToIntersection<...Components["schemas"]>`（`packages/genapi/src/index.ts:763-779`）                                                                | 同名 schema 的字段可能被错误交叉                    |
| alias 冲突会静默丢弃                   | namespace 和全局 alias 已存在时直接 `continue`（`packages/genapi/src/index.ts:720-742`）                                                                                   | 结果依赖 service 顺序                               |
| runtime config 是手写镜像              | 生成的 `Api*ClientConfig` 只转发部分字段（`packages/genapi/src/index.ts:513-553`）；Core `NetConfig` 另有 `retryDelayMs`、`logger`（`packages/core/src/types.ts:228-260`） | Core 增加能力时生成 client 容易继续漏字段           |
| 输出不是确定性的                       | `renderIndex()` 写入 `new Date().toISOString()`（`packages/genapi/src/index.ts:422-445`）                                                                                  | 相同输入连续生成也产生 diff                         |
| CLI 没有严格参数和检查模式             | `parseCli()` 只识别现有少量参数，未知 `--flag` 会被忽略；project 逐个调用 `generate()`（`packages/genapi/src/cli.ts:122-190`）                                             | 拼错参数不失败，`all` 的后续 project 失败时前项已改 |
| genapi 测试集中在独立消费者冒烟        | `packages/genapi/test/independent-cli.test.js` 当前只有“携带 TypeScript runtime”和“无提升 binary 也可生成”两项测试                                                         | 核心生成契约没有直接回归保护                        |
| 生成工具链仍允许漂移                   | `packages/genapi/package.json` 使用 `openapi-typescript: ^7`、`typescript: ^5.9.3`、`esbuild: ^0.28.1`                                                                     | 发布后不同安装时间可能解析到不同工具版本            |

### 4.1 P0：类型正确性与产物一致性

#### 4.1.1 `AllSchemas` 会错误合并不同服务的数据结构

当前多 service 实现把所有 `components["schemas"]` 转成 intersection：

```ts
export type AllSchemas = UnionToIntersection<BaseComponents["schemas"] | BillingComponents["schemas"]>;
```

如果两个 service 都有 `UserDto`，但字段类型不同：

```ts
// base
type UserDto = { id: string };

// billing
type UserDto = { id: number };
```

交叉结果可能变成：

```ts
type UserDto = {
  id: never;
};
```

这不是类型收窄，而是把两个本来独立的服务契约错误地合并了。当前实现位置见 [`packages/genapi/src/index.ts`](../../packages/genapi/src/index.ts)。

#### 4.1.2 schema alias 冲突会静默跳过

当前 namespace 内和全局 alias 都使用 `Set` 去重，冲突时直接跳过后出现的 schema。结果取决于 service 顺序，而且生成不会报错。

另一个问题是自动冲突名。某个短名原本唯一时会导出 `UserDto`；新增第二个同名 schema 后，原导出可能自动改成末两段名称，导致已有业务 import 在一次正常重新生成后失效。

v2 不允许静默跳过，也不允许新增服务隐式改变已有公共导出。

#### 4.1.3 hooks 前后的文档来源不一致

当前流程：

```text
原始 Swagger
  ├─ transformSwagger → 临时文档 → openapi-typescript → types/<service>.ts
  ├─ 原始 Swagger → endpoint 统计
  └─ 原始 Swagger → api-types.ts
```

如果 hook 删除或重命名 schema，`types/<service>.ts` 已按新名称生成，但 `api-types.ts` 仍可能引用旧名称。hook 过滤 path 时，生成注释中的 endpoint 数量也可能与真实 client 不一致。

#### 4.1.4 生成过程不是原子的

当前生成器直接写正式输出目录。多 service 中任意一步失败，都可能留下部分新文件和部分旧文件。

还存在以下情况：

- 配置删除一个 service 后，旧 `types/<service>.ts` 不会自动清理。
- 配置声明的 Swagger 缺失时只警告并跳过，旧产物可能继续留在目录中。
- `transformTypes` 抛错时，前面的文件已经写入。
- `api-types.ts` 生成失败时，service 类型可能已经更新。

#### 4.1.5 project/service 名称没有完整校验

名称同时参与目录、文件名、变量名和类型名生成。以下配置可能冲突或生成非法代码：

```text
order-api → runtime key order_api，类型 OrderApi
order_api → runtime key order_api，类型 OrderApi
1base     → 非法 TypeScript 标识符
foo.bar   → 类型名中保留点号
../demo   → 路径越界风险
```

`defineConfig` 的 TypeScript 类型不能替代运行时校验，CLI 在读取配置后必须执行完整验证。

#### 4.1.6 `all` 没有完整事务边界

当前 CLI 按 project 顺序调用 `generate()`，每个 project 完成后立即修改正式目录。如果 `xapiforge all` 的后一个 project 失败，前面的 project 已经更新，整次命令处于部分成功状态。

v2 必须区分两个层次：

- 库级 `generate(project)`：单 project 的准备、验证和替换是一个事务。
- CLI `xapiforge all`：所有目标先完成配置校验和 staging，再进入提交阶段；任一 staging 失败时不修改任何正式 project 目录。

多个目录在常见文件系统上无法形成真正的单指令原子提交。提交阶段如果发生 rename 或进程级故障，必须保留可识别的 backup/staging 状态并在下次运行时恢复或给出明确修复指令，不能声称跨目录具备数据库式原子性。

### 4.2 P1：多服务运行时与配置范围

#### 4.2.1 所有 service 共用同一个运行时 `baseURL`

当前生成的 project client 只接收一个 `baseURL`，然后把同一份 `netConfig` 传给每个 service。

这可以支持同一 API 网关下的多个微服务，但不能直接表达：

```text
identity       → https://identity.example.test
infrastructure → https://infra.example.test
catalog        → https://catalog.example.test
```

配置中的 `services[].baseHost/port/path` 目前用于构造 Swagger 下载地址，不是应用运行时地址。两个概念需要在文档和类型上明确分开。

#### 4.2.2 生成的 ClientConfig 与 Core `NetConfig` 漂移

生成器手写了一份 client config，并手动把字段复制到 `createNet`。当前 Core 的 `NetConfig` 已包含 `retryDelayMs` 和 `logger`，生成的 config 没有暴露，也没有转发。

只要 Core 新增字段，手写镜像就可能再次遗漏。v2 应直接基于 `NetConfig` 定义生成配置，避免维护第二份接口。

#### 4.2.3 namespace 配置是全局的

`namespacePrefixAliases` 当前位于整个 `XApiForgeConfig` 顶层。多个 project 使用不同 schema 命名规则时，无法独立配置。

v2 的类型导出规则应属于 project，并可以进一步限定 service。

#### 4.2.4 project 缺少 hooks 默认值

当前 hooks 只能放在 `XApiForgeConfig` 顶层或单个 service。多个 project 使用不同 Swagger 规范化规则时，只能给每个 service 重复配置，project 作为生成边界却不能声明自己的默认规则。

v2 增加 `projects[].hooks`，固定优先级为：

```text
service hooks > project hooks > root hooks
```

每一级仍采用整体覆盖语义；显式 `{}` 表示停止继承，而不是把多个 hook 对象按字段隐式合并。

### 4.3 P2：可复现性、测试与文档

#### 4.3.1 输出包含当前时间

生成的 `index.ts` 写入当前时间。同一份 Swagger 连续生成两次也会产生 Git diff，不利于 CI 检查和代码 review。

#### 4.3.2 生成依赖使用范围版本

`openapi-typescript`、TypeScript 和用于加载配置的 esbuild 当前都使用范围版本。不同时间安装相同版本的 `@xapiforge/genapi`，可能解析到不同工具版本并产生不同结果。

直接影响生成结果的依赖应精确锁定，并随 genapi 版本升级。仓库内“字节一致”的强保证以 frozen lockfile 和相同 Node 平台为边界；发布包还应在 manifest 记录实际解析到的工具版本。仅精确声明直接依赖不能证明所有跨包管理器、跨平台安装都拥有完全相同的传递依赖树。

#### 4.3.3 测试覆盖不足

当前 genapi 测试主要验证：

- 发布包携带兼容 TypeScript runtime。
- 独立消费者不依赖被提升的 CLI binary 也能生成一个简单 ping 类型。

尚未覆盖：

- 多 service。
- 同名不同结构 schema。
- namespace。
- 标准枚举和 legacy 枚举。
- hooks 删除、重命名、增加 schema。
- 冲突诊断。
- 旧文件清理和原子替换。
- 多运行时地址。
- 确定性生成。

#### 4.3.4 文档没有形成完整接入路径

- 主接入文档没有说明 project 与 service 的选择原则。
- 没有说明 Swagger 下载地址和 API 运行时地址的区别。
- namespace 配置没有进入主接入文档。
- 枚举文档描述了 hook，但仓库没有可以直接运行的示例文件。
- 没有多服务生成目录、client 初始化和冲突处理示例。

---

## 5. v2 核心设计原则

### 5.1 service 类型是权威类型

每个 service 的 `types/<service>.ts` 是该服务的唯一权威 OpenAPI 类型。跨 service 的便利导出只能引用它，不能重新解释或合并它。

### 5.2 canonical API 与 convenience API 分离

- canonical API 必须无歧义，始终可以按 service 和 schema full name 定位类型。
- namespace、短名和 alias 是 convenience API，可以选择启用，但必须经过冲突检查。

### 5.3 无法安全推导时失败

以下情况默认失败，不自动猜测：

- project 或 service ID 重复。
- 生成后的 TypeScript 标识符冲突。
- namespace 中出现相同 alias。
- 显式 alias 指向不存在的 schema。
- 配置要求生成的 Swagger 文件缺失。
- hook 返回空值或返回的内容不是可用 OpenAPI 文档。

### 5.4 一次规范化，全程复用

一个 service 的 hook 后文档必须同时供以下步骤使用：

- `openapi-typescript`。
- path 和 endpoint 元数据分析。
- schema alias 与 namespace 生成。
- enum runtime 产物生成。
- source hash 和 manifest。

### 5.5 相同输入必须得到相同输出

生成内容不写当前时间，不依赖不受控排序，不使用浮动的核心生成依赖版本。

---

## 6. 目标生成流水线

```text
加载 xapiforge.config.ts
  ↓
解析 CLI 参数并拒绝未知参数
  ↓
validateConfig（对本次所有目标 project）
  - ID 格式
  - project/service 唯一性
  - 生成标识符唯一性
  - namespace/alias 配置合法性
  ↓
loadServiceDocuments
  - 读取原始 Swagger
  - JSON/OpenAPI 基础校验
  ↓
normalizeServiceDocuments
  - 每个 service 执行一次 transformSwagger
  - 校验 hook 后文档
  - 形成 ServiceModel
  ↓
analyzeProject
  - path/operation 统计
  - schema identity
  - namespace/alias 冲突
  - enum metadata
  ↓
generateToStagingDirectory
  - types/<service>.ts
  - api-types.ts
  - index.ts
  - manifest.json
  ↓
verifyGeneratedArtifacts
  - 文件存在
  - TypeScript 可解析/编译
  - 不存在悬空 schema 引用
  ↓
replaceOutputDirectory
  - 单 project：替换正式目录并清理旧 service 文件
  - all：所有 project staging 成功后才进入提交阶段
  - 失败：恢复 backup；保留可诊断状态
```

### 6.1 中间模型

内部实现应引入清晰的 project/service 模型，而不是在不同渲染函数中重复读取 JSON：

```ts
interface ServiceModel {
  projectId: string;
  serviceId: string;
  sourcePath: string;
  originalDocument: unknown;
  document: OpenApiDocument;
  sourceHash: string;
  schemas: ReadonlyMap<string, unknown>;
  operations: readonly OperationInfo[];
  hooks?: GenapiHooks;
}

interface ProjectModel {
  project: ProjectConfig;
  services: readonly ServiceModel[];
  typeExports: ResolvedTypeExportConfig;
}
```

`document` 是 hook 后文档。渲染函数不再接收 Swagger 目录并自行读取原文件，只接收 `ProjectModel`。`sourceHash` 的输入和序列化规则必须固定；如果 hash 表示规范化文档，应改名为 `normalizedDocumentHash`，避免与原始文件 hash 混淆。

### 6.2 hooks 上下文

现有 `swaggerPath` 继续表示原始文件。v2 可以扩展上下文：

```ts
interface GenapiHookContext {
  projectId: string;
  serviceName: string;
  swaggerPath: string;
  typesPath: string;
  originalDocument?: unknown;
  normalizedDocument?: unknown;
}
```

原则：

- `transformSwagger` 只执行一次。
- `transformTypes` 可以访问同一份规范化文档，不需要重新读取并重复解析原始 Swagger。
- `swaggerPath` 继续指向原始输入文件；`typesPath` 表示逻辑上的最终目标路径，hook 执行时该文件不保证已经存在。
- hook 通过入参和返回值工作，不读取或写入正式输出目录。staging 的物理路径不作为公共 API 暴露。
- hook 不允许直接修改正式生成目录中的其他文件。
- hook 失败中断整个 project 生成，并保留旧产物。

### 6.3 事务范围与故障模型

v2 使用“先准备、后提交”的事务模型，但不把文件系统 rename 描述成数据库事务：

1. `prepare`：加载、规范化、分析并把所有目标写入相邻 staging 目录；此阶段不得修改正式目录。
2. `verify`：检查文件清单、TypeScript 编译和 manifest；任一目标失败则删除本次 staging。
3. `commit`：正式目录先 rename 为带本次 transaction ID 的 backup，再把 staging rename 为正式目录。
4. `recover`：正常异常时按相反顺序恢复；进程崩溃后，下次命令先识别遗留 transaction state，再继续恢复或停止并打印精确路径。

`generate(project)` 只覆盖一个 project。CLI `all` 必须先 prepare/verify 全部目标，随后统一进入 commit；不能在循环中边生成边提交。跨 project 提交仍是带 rollback 的两阶段替换，不承诺不可观察的瞬时全局原子性。

---

## 7. 配置设计

### 7.1 名称规则

project 和 service ID 采用小写 kebab-case：

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
```

有效示例：

```text
demo
identity
infrastructure-api
service2
```

无效示例：

```text
Demo
1service
order_api
foo.bar
../service
```

CLI 还必须检查：

- project ID 不重复。
- 同一 project 下 service ID 不重复。
- `cap(id)` 生成的类型名不重复。
- runtime property 生成名不重复。
- 输出路径解析后仍位于配置的输出根目录内。

### 7.2 类型导出配置下沉到 project

目标配置：

```ts
export default defineConfig({
  outputDir: "swagger",
  genOutputDir: "src/api/gen",
  mode: "offline",
  projects: [
    {
      name: "demo",
      displayName: "Demo Application",
      baseHost: "http://localhost",
      services: [
        { name: "base", displayName: "Base API", port: 8787 },
        {
          name: "infrastructure",
          displayName: "Infrastructure API",
          port: 8788
        }
      ],
      typeExports: {
        collisionPolicy: "error",
        namespaces: [
          {
            service: "infrastructure",
            match: "Sample.Infrastructure.",
            namespace: "Infrastructure"
          },
          {
            service: "base",
            match: "Sample.Identity.",
            namespace: "Identity"
          }
        ],
        aliases: [
          {
            service: "base",
            schema: "Sample.Identity.UserDto",
            exportAs: "IdentityUserDto"
          }
        ]
      }
    }
  ]
});
```

建议类型：

```ts
interface ProjectTypeExportConfig {
  collisionPolicy?: "error";
  namespaces?: NamespaceRule[];
  aliases?: SchemaAliasRule[];
}

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
```

现有顶层 `namespacePrefixAliases` 先保留并转换成 project 默认规则，同时输出弃用提示。新项目只使用 `projects[].typeExports`。

`ProjectConfig` 同时增加可选 `hooks`，继承关系固定为：

```ts
interface ProjectConfig {
  // ...现有字段
  hooks?: GenapiHooks;
  typeExports?: ProjectTypeExportConfig;
}

const resolvedHooks = service.hooks ?? project.hooks ?? config.hooks;
```

这里保留当前“整体覆盖”合同。不能使用对象展开合并 hooks，否则 service 只覆盖一个 hook 时会意外继承其它层的 hook，破坏显式 `{}` 禁用语义。

### 7.3 Swagger 来源与运行时地址分离

生成配置中的 `baseHost/port/path` 只负责定位 Swagger。文档中统一称为“Swagger source”。

运行时地址由应用初始化 client 时传入，来自环境变量或应用配置，不从 Swagger 下载地址推导。

后续可以把 source 配置明确化：

```ts
services: [
  {
    name: "infrastructure",
    displayName: "Infrastructure API",
    source: {
      url: "http://localhost:8788/swagger/v1/swagger.json"
    }
  }
];
```

离线模式：

```ts
source: {
  file: "swagger/demo/infrastructure.json",
}
```

第一阶段可以继续兼容 `baseHost/port/path`，不要求一次性替换现有配置。

---

## 8. 目标类型导出结构

### 8.1 保持现有目录

v2 第一阶段不修改生成目录：

```text
src/api/gen/demo/
├── index.ts
├── api-types.ts
├── manifest.json
└── types/
    ├── base.ts
    └── infrastructure.ts
```

这样现有 `./gen/demo/index.js` 和 `./gen/demo/types/base.js` 导入路径保持兼容。

### 8.2 `SchemasByService`

`api-types.ts` 增加无歧义的 canonical API：

```ts
import type { components as BaseComponents } from "./types/base.js";
import type { components as InfrastructureComponents } from "./types/infrastructure.js";

export interface SchemasByService {
  base: BaseComponents["schemas"];
  infrastructure: InfrastructureComponents["schemas"];
}

export type ServiceName = keyof SchemasByService;

export type SchemaOf<Service extends ServiceName, Name extends keyof SchemasByService[Service]> = SchemasByService[Service][Name];
```

使用示例：

```ts
type IdentityUser = SchemaOf<"base", "Sample.Identity.UserDto">;

type InfrastructureUser = SchemaOf<"infrastructure", "Sample.Infrastructure.UserDto">;
```

两个 schema 即使都叫 `UserDto`，也不会相互覆盖。

### 8.3 namespace 是便利导出

配置命中后生成：

```ts
export namespace Infrastructure {
  export type DeviceDto = SchemaOf<"infrastructure", "Sample.Infrastructure.DeviceDto">;

  export type DeviceState = SchemaOf<"infrastructure", "Sample.Infrastructure.DeviceState">;
}
```

业务侧可以使用：

```ts
import type { Infrastructure } from "./api/gen/demo/api-types.js";

const device: Infrastructure.DeviceDto = value;
```

生成器必须记录每个 alias 的 service 和 full schema name。namespace 只影响导出方式，不改变 schema identity。

### 8.4 冲突规则

以下情况直接失败：

```text
同一 namespace 下：
  service-a + Sample.A.ItemDto → ItemDto
  service-b + Sample.B.ItemDto → ItemDto
```

错误信息必须列出：

- 冲突后的 namespace 和 alias。
- 两个 service。
- 两个 full schema name。
- 可采用的 `typeExports.aliases` 配置示例。

不采用以下策略：

- 按 service 顺序保留第一个。
- 静默跳过后面的类型。
- 新增冲突后自动重命名已有 alias。
- 根据 schema 结构相似度猜测它们是同一个类型。

### 8.5 `AllSchemas` 迁移

类型正确性优先于表面兼容。仅给当前错误的 intersection 加 `@deprecated` 仍会继续制造错误类型，不能作为 v2 默认行为。建议分三步处理：

1. 单 service project 继续导出原语义的 `AllSchemas`。
2. 多 service project 默认不再生成交叉合并的 `AllSchemas`，新代码使用 `SchemasByService`/`SchemaOf`。
3. 如果发布节奏要求短期兼容，可提供显式 `compatibility.legacyAllSchemas: true`；只有所有 service 的 full schema name 全局唯一时才允许生成并标记 `@deprecated`，一旦发现重复名称立即失败，不生成错误交叉类型。

兼容开关的默认值、保留版本数和移除版本属于发布决策，必须记录到 CHANGELOG。无论选择哪个发布版本，都不能在已发现重复 schema 时继续静默输出当前 intersection。

---

## 9. 多服务运行时设计

### 9.1 适用规则

| 情况                                     | 推荐配置                                    |
| ---------------------------------------- | ------------------------------------------- |
| 同一网关、同一认证和协议                 | 一个 project，多个 service，共享 defaults   |
| 不同运行时地址，但认证和协议一致         | 一个 project，service 覆盖 `baseURL`        |
| 不同 middleware，但仍属于同一应用 client | 一个 project，service 覆盖 `middleware`     |
| 不同认证生命周期或完全不同协议           | 拆成不同 project                            |
| 只是 schema 同名                         | 保持 service 隔离，不拆不合均由部署边界决定 |

### 9.2 ClientConfig 目标形态

兼容式扩展示例：

```ts
const api = createDemoClient({
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

合并规则固定为：

```text
service override > defaults
```

只使用 override 中值不为 `undefined` 的字段覆盖 defaults，避免对象展开把必需默认值意外清空。数组字段不做隐式拼接。service 显式提供 `middleware` 时表示替换 defaults 中的 middleware；需要组合时由接入者明确写出：

```ts
middleware: [...commonMiddleware, infrastructureMiddleware];
```

### 9.3 兼容现有初始化方式

现有代码继续可用：

```ts
const api = createDemoClient({
  baseURL,
  authService,
  middleware
});
```

内部把它解释为所有 service 的 defaults。v2 新增的 `defaults/services` 结构用于多地址或服务级覆盖。

### 9.4 直接复用 Core 类型

生成器不再手写一份 `NetConfig` 镜像。建议从 Core 导入：

```ts
import type { NetConfig } from "@xapiforge/core";

export type ApiDemoServiceOverrides = Partial<Pick<NetConfig, "baseURL" | "authService" | "middleware" | "fetch" | "defaultTimeoutMs" | "maxRetries" | "retryDelayMs" | "logger">>;
```

`validateStatus` 会影响返回值类型，是否允许 service 级覆盖应单独设计类型推导，不和第一阶段的 URL 支持绑在一起。第一阶段可以继续保持 project 级 `validateStatus`。

---

## 10. 枚举与 hooks

### 10.1 标准 OpenAPI 枚举

标准枚举由 `openapi-typescript` 生成 literal union：

```ts
type DeviceState = 0 | 1 | 2;
type TaskStatus = "pending" | "running" | "completed";
```

这是默认、权威的类型表达。v2 不默认切换成 TypeScript `enum`。

### 10.2 可选运行时枚举

对于规范化后的：

```json
{
  "type": "integer",
  "enum": [0, 1],
  "x-enum-varnames": ["Offline", "Online"],
  "x-enum-labels": ["离线", "在线"]
}
```

可以由显式启用的通用 helper 生成：

```ts
export const DeviceState = {
  Offline: 0,
  Online: 1
} as const;

export type DeviceStateValue = (typeof DeviceState)[keyof typeof DeviceState];

export const DeviceStateLabels = {
  0: "离线",
  1: "在线"
} as const;
```

选择 `as const` 而不是 TypeScript `enum`，原因是序列化值清晰、tree-shaking 更直接、生成结果容易检查。

### 10.3 非标准枚举

类似下面的历史格式不是合法的标准数字枚举：

```json
{
  "type": "integer",
  "enum": ["Offline(离线)=0", "Online(在线)=1"]
}
```

处理流程：

```text
legacy Swagger
  → 业务 transformSwagger
  → 标准 enum + x-enum-varnames/x-enum-labels
  → openapi-typescript literal union
  → 可选 runtime enum helper
```

仓库应提供真实可运行的示例 hook 和测试，但示例只放在 demo/fixture，不成为内核默认行为。

### 10.4 Flags enum

Flags 值可能出现 `1 | 4 = 5` 这种组合，literal union `1 | 2 | 4` 无法表达所有运行时结果。

对于显式标记的 Flags：

- API 字段类型使用 `number`。
- 仍可生成单项名称和 label map。
- 文档明确组合值需要位运算处理。
- 不由生成器穷举所有组合。

---

## 11. 原子生成与确定性

### 11.1 staging 与替换

每个 project 先生成到同级临时目录：

```text
src/api/gen/.demo.xapiforge-tmp-<random>/
```

全部验证成功后再替换：

```text
旧 demo → 临时 backup
staging → demo
成功后删除 backup
```

替换失败时尝试恢复 backup。Windows 和 POSIX 的目录 rename 行为不同，实现时必须有跨平台测试。

正式输出目录只能包含本次 manifest 声明的文件。移除 service 后，旧类型文件自然随目录替换消失。

### 11.2 缺失 Swagger

配置中声明的 service 默认都是 required。Swagger 缺失时整个 project 生成失败。

如果确实需要占位服务，应增加显式字段，而不是通过 `port: 0` 和缺文件隐式跳过：

```ts
{
  name: "future-service",
  enabled: false,
}
```

disabled service 不进入生成结果、统计或 manifest。

### 11.3 移除生成时间

生成代码不写当前时间。需要追踪的信息进入 `manifest.json`，但 manifest 也不放导致每次变化的 wall-clock 时间。

建议 manifest：

```json
{
  "formatVersion": 2,
  "generator": "@xapiforge/genapi",
  "generatorVersion": "0.2.0",
  "openapiTypescriptVersion": "7.13.0",
  "typescriptVersion": "5.9.3",
  "esbuildVersion": "0.28.1",
  "project": "demo",
  "services": {
    "base": {
      "sourceHash": "sha256:..."
    },
    "infrastructure": {
      "sourceHash": "sha256:..."
    }
  }
}
```

版本号只是结构示例，实际值由构建时读取 package metadata。

### 11.4 精确锁定生成依赖

直接改变生成文本或 AST 的依赖使用精确版本：

```json
{
  "dependencies": {
    "esbuild": "0.28.1",
    "openapi-typescript": "7.13.0",
    "typescript": "5.9.3"
  }
}
```

升级这些依赖时：

1. 单独提交依赖升级。
2. 重新生成 fixture。
3. review 所有生成 diff。
4. 跑完整 genapi 测试和独立消费者编译。
5. 在 CHANGELOG 说明生成结果是否发生变化。

### 11.5 `--check`

新增：

```bash
xapiforge demo --check

# examples/demo-app 的 generate:api 脚本已经固定 project=demo
pnpm run generate:api -- --check
```

行为：

- 在 staging 中生成。
- 与正式输出目录比较。
- 完全一致返回 0。
- 有差异打印文件清单并返回非 0。
- 不修改正式目录。
- 未知参数、重复 project 参数或缺少参数值时返回非 0，不再静默忽略。

CI 使用 `--check` 防止 Swagger、配置和生成产物漂移。

---

## 12. Demo 与 fixture 设计

### 12.1 文件结构

不构造一个难以维护的超大 Swagger。按服务和用途拆分：

```text
examples/demo-app/swagger/
├── demo/
│   ├── base.json
│   └── infrastructure.json
└── legacy-demo/
    └── legacy.json
```

#### `demo/base.json`

保留当前常规接入场景：

- token。
- 用户 CRUD。
- 分页。
- 业务错误。
- multipart 上传。
- 第三方接口。

#### `demo/infrastructure.json`

作为第二个标准微服务，使用完全虚构的数据：

- `Sample.Infrastructure.*` 完整 schema 名。
- `Infrastructure` namespace。
- 字符串枚举和数字枚举。
- required、optional、nullable。
- 数组、嵌套对象和 `additionalProperties`。
- `allOf`、`oneOf`、`anyOf`、discriminator。
- uuid、date-time、int32、int64、binary。
- path/query/header/cookie parameter。
- JSON、form-urlencoded、multipart request body。
- 200、201、204、default error、binary response。
- bearer 和 apiKey security scheme。
- 与 base service 相同的 path。
- 与 base service 相同短名但结构不同的 schema。

#### `legacy-demo/legacy.json`

只用于验证 hooks：

- 非标准数字枚举字符串。
- `x-enum-varnames` 和 `x-enum-labels` 补全。
- Flags enum。
- hook 删除 path。
- hook 重命名或增加 schema。
- 空 `additionalProperties` 规范化。

标准 fixture 必须始终是合法 OpenAPI；非标准情况不能混进标准 fixture。

### 12.2 数据安全

所有示例必须满足：

- 使用 `Sample.*`、`Example.*` 等明确虚构的命名。
- 只使用 localhost、`.test` 域名和文档保留地址。
- 不复制任何真实服务名、公司命名空间、内部 IP、业务枚举、用户数据或真实错误码。
- 生成产物、文档构建产物和 npm tarball 都要纳入发布前检查。

---

## 13. 测试矩阵

### 13.1 配置校验

- 合法 project/service ID 通过。
- 数字开头、下划线、点号、路径片段失败。
- 重复 project ID 失败。
- 重复 service ID 失败。
- 生成 TypeScript 名称冲突失败。
- namespace 名不是合法标识符时失败。
- alias 指向不存在 service/schema 时失败。
- project/service/root hooks 的整体覆盖优先级正确，显式 `{}` 停止继承。
- CLI 未知参数、重复位置参数和缺少参数值时失败。

### 13.2 类型隔离

- 两个 service 有相同 path，分别出现在自己的 `paths` 中。
- 两个 service 有相同 full schema name 和不同字段，`SchemaOf` 能分别得到正确类型。
- 不生成会把字段交叉为 `never` 的公共类型。
- 同一 namespace 出现相同短名时明确失败。
- 显式 alias 后生成成功。

### 13.3 hooks 一致性

- hook 删除 schema 后不生成悬空 alias。
- hook 重命名 schema 后 namespace 使用新名称。
- hook 新增 schema 后可以通过 `SchemaOf` 访问。
- hook 删除 path 后 endpoint 统计同步变化。
- `transformSwagger` 每个 service 只执行一次。
- `transformTypes` 得到对应的规范化文档。
- hook 无法读取或修改正式输出目录中的半成品。

### 13.4 原子性

- 第二个 service 失败时，正式输出目录字节不变。
- hook 失败时旧目录不变。
- 移除 service 后旧类型文件被清理。
- 缺失 required Swagger 时失败。
- disabled service 不生成文件。
- 替换失败时能恢复旧目录。
- `all` 的最后一个 project staging 失败时，前面 project 的正式目录也保持不变。
- 模拟提交阶段中断后，下次运行可以识别 backup/staging 并恢复或给出明确处理路径。

### 13.5 确定性

- 连续生成两次，所有文件字节一致。
- service 配置顺序按合同处理，生成顺序稳定。
- schema 和 namespace 输出排序稳定。
- 生成文本统一使用 LF，不继承宿主平台换行。
- frozen lockfile 下记录的生成工具链版本与 manifest 一致。
- `--check` 对无差异返回 0。
- `--check` 能发现 Swagger 或配置变化。

### 13.6 枚举

- 字符串 enum 生成正确 union。
- 数字 enum 生成正确 union。
- `x-enum-varnames` 生成运行时对象。
- `x-enum-labels` 生成 label map。
- legacy enum 经 hook 规范化后类型与运行时数值一致。
- Flags enum 使用 `number`，单项 map 仍可用。
- enum metadata 长度不一致时明确失败。

### 13.7 多服务运行时

使用自定义 fetch 记录 URL：

- 未配置 override 时所有 service 使用 defaults baseURL。
- infrastructure override 后只影响该 service。
- service middleware 替换规则符合文档。
- override 中值为 `undefined` 的字段不会清空 defaults。
- retry、logger、timeout 和 fetch 能从 Core `NetConfig` 正确传递。
- 不同 project 可以使用完全独立的地址、auth 和 middleware。

### 13.8 独立消费者

至少验证：

- npm 安装后的 CLI 可运行。
- npm 和 pnpm 项目均能生成。
- 不依赖消费者提升传递依赖的 binary。
- 生成的 demo 多服务代码通过 `tsc --noEmit`。
- 真实调用示例可以从正确 service 得到响应类型。

---

## 14. 兼容策略

### 14.1 保持兼容

- 默认生成目录继续是 `src/api/gen`。
- project 目录结构不变。
- `types/<service>.ts` 路径不变。
- `create<Project>Client({ baseURL, authService, ... })` 继续支持。
- 单 service 的短名导出继续支持。
- 顶层 `namespacePrefixAliases` 暂时兼容。
- 顶层 hooks 继续作为所有 project 的最终 fallback。

### 14.2 新增能力

- `SchemasByService` 和 `SchemaOf`。
- project 级 `typeExports`。
- project 级 hooks 默认值。
- service 运行时 override。
- staging/atomic replace。
- deterministic manifest。
- `--check`。
- 可运行的 enum hooks 示例。

### 14.3 弃用项

- 多 service 场景使用 `AllSchemas`。
- 顶层 `namespacePrefixAliases`。
- 把 `services[].baseHost/port/path` 理解成运行时地址。
- 缺失 Swagger 时静默跳过。

弃用必须在生成日志、类型 JSDoc、迁移文档和 CHANGELOG 中同步说明。

---

## 15. 开发拆分

### V2-01：配置校验与生成中间模型

范围：

- `validateConfig`。
- project/service ID 和冲突检查。
- `ServiceModel`、`ProjectModel`。
- project hooks 与 service/root hooks 的解析规则。
- hook 后文档只生成一次并在后续复用。
- v2 第一阶段拒绝远程 `$ref`，错误中列出 service 和 ref；本地文档内引用保持支持。
- endpoint 提取只识别合法 HTTP method，避免把 path-level `parameters` 当成 operation。

完成标准：

- 配置错误在写文件前失败。
- types、api-types 和统计都使用同一份规范化文档。
- 对应单元测试完成。

### V2-02：确定性与原子生成

范围：

- staging 目录。
- 单 project 和 CLI `all` 的 prepare/verify/commit/recover。
- replace/rollback 与遗留 transaction state 恢复。
- stale 文件清理。
- 移除生成时间。
- manifest。
- 精确锁定生成依赖。
- CLI 严格参数解析。
- `--check`。

完成标准：

- 相同输入连续生成字节一致。
- 任一步失败后旧目录不变。
- `all` 不会因为后一个 project 失败而留下前面 project 的新产物。
- CI 可以检测生成漂移。

### V2-03：多服务类型导出

范围：

- `SchemasByService`。
- `SchemaOf`。
- project/service 级 namespace 规则。
- 显式 alias。
- 严格冲突诊断。
- 多 service `AllSchemas` 的默认移除与显式 legacy 兼容门禁。

完成标准：

- 同名不同结构 schema 不被合并。
- `Infrastructure.DeviceDto` 可以正常使用。
- 新增冲突不会静默改变已有导出。

### V2-04：多服务运行时配置

范围：

- defaults + service overrides。
- 保持旧 `baseURL` 初始化方式。
- 复用 Core `NetConfig`。
- baseURL/middleware/fetch/auth/retry/logger 的明确覆盖规则。

完成标准：

- 自定义 fetch 测试证明请求发往正确服务地址。
- 单服务旧接入代码无需修改。

### V2-05：枚举与 hooks 示例

范围：

- 标准 enum fixture。
- 通用 runtime enum helper。
- legacy enum 示例 hook。
- Flags 处理。
- enum metadata 校验。

完成标准：

- 类型值与真实序列化值一致。
- 示例 hook 可以直接复制运行。
- 内核不包含业务后端专用规则。

### V2-06：Demo、文档与发布准备

范围：

- `infrastructure.json`。
- `legacy.json`。
- demo 多 service 调用。
- 接入文档、多服务指南、维护指南和迁移说明。
- npm dry-run 和独立消费者试装。

完成标准：

- 新接入者只按文档即可完成单服务、多服务和独立 project 接入。
- 维护者可以按文档更新 fixture、生成代码、运行检查和发布。
- `pnpm verify` 完整通过。

开发顺序原则：先保证生成正确和可回滚，再扩展运行时 API，最后增加复杂 fixture。不要用 demo 反向驱动一套未经验证的生成契约。

---

## 16. v2 验收清单

### 配置

- [ ] project/service ID 有明确格式和运行时校验。
- [ ] 重复 ID 和生成标识符冲突会失败。
- [ ] namespace 和 alias 配置属于 project，可限定 service。
- [ ] hooks 支持 service > project > root 的整体覆盖，并保留 `{}` 禁用语义。
- [ ] Swagger source 与运行时 baseURL 在文档和类型中明确分离。

### 生成正确性

- [ ] 每个 service 保持独立 `paths` 和 `components`。
- [ ] 多服务 schema 不再通过 `AllSchemas` 隐式交叉合并。
- [ ] `SchemasByService` 和 `SchemaOf` 可用。
- [ ] namespace alias 冲突不会静默跳过。
- [ ] types、api-types、enum 和统计都基于同一份规范化文档。

### 稳定性

- [ ] 相同输入生成结果字节一致。
- [ ] 生成文件不包含当前时间。
- [ ] 生成核心依赖精确锁定。
- [ ] 生成在 staging 中完成并原子替换。
- [ ] 失败时旧产物保持不变。
- [ ] CLI `all` 在全部目标 staging 成功前不修改正式目录，并能恢复中断的提交状态。
- [ ] 删除 service 后没有 stale 文件。
- [ ] `--check` 可以用于 CI。
- [ ] 未知或不完整 CLI 参数会失败。

### 多服务

- [ ] 同一网关多个 service 可共享 defaults。
- [ ] service 可以覆盖运行时 baseURL。
- [ ] 不同 project 可以使用独立 auth、middleware 和地址。
- [ ] 同名不同结构 schema 有明确、无歧义的访问方式。
- [ ] Core `NetConfig` 能力不会在生成 client 中丢失。

### 枚举和 hooks

- [ ] 标准字符串和数字 enum 类型正确。
- [ ] 可选 runtime enum 和 label 可用。
- [ ] legacy enum 示例 hook 可运行。
- [ ] Flags enum 有明确类型和文档。
- [ ] hook 重命名、增加、删除 schema 后导出保持一致。

### 测试和文档

- [ ] 标准、多服务、legacy fixture 分开维护。
- [ ] fixture 不包含真实组织、服务、地址或业务数据。
- [ ] genapi 单元、集成、消费者编译和 runtime URL 测试完成。
- [ ] 主接入文档说明 project/service 的选择规则。
- [ ] 维护文档说明生成、检查、升级依赖和发布步骤。
- [ ] CHANGELOG 记录兼容项、新增项和弃用项。

只有以上检查完成并通过 `pnpm verify`，genapi v2 才进入发布候选阶段。

---

## 17. 开发基线采用的设计决策

1. 不跨 service 自动合并 schema。
2. schema identity 包含 project、service 和 full schema name。
3. `SchemasByService`/`SchemaOf` 是多服务 canonical API。
4. namespace 和短 alias 是经过冲突检查的 convenience API。
5. 标准 enum 默认使用 literal union，不默认生成 TypeScript `enum`。
6. legacy Swagger 通过 hooks 规范化，不进入通用内核默认规则。
7. 保持现有生成目录，降低接入迁移成本。
8. 运行时地址不从 Swagger 下载地址推导。
9. 仓库内确定性保证以 frozen lockfile、记录的工具链版本和统一 LF 输出为边界。
10. `generate(project)` 采用单 project 事务；CLI `all` 必须先 prepare/verify 全部目标，再进入带 rollback 的提交阶段。
11. hooks 优先级为 service > project > root，每一级整体覆盖，显式 `{}` 停止继承。
12. 多 service 默认不生成当前错误的 `AllSchemas` intersection；legacy 兼容只允许显式开启且 schema full name 全局无重复。
13. v2 第一阶段拒绝远程 `$ref`；需要远程引用时先设计锁定、缓存和离线校验合同。
14. 未知 CLI 参数必须失败，不能继续静默忽略。

## 18. 开发开始前仍需确认的事项

以下问题不阻塞 V2-01，但必须在对应阶段开始前确定：

1. npm 发布版本使用 `0.2.0`、`1.0.0` 还是其它版本号。
2. 多 service 的旧 `AllSchemas` 在哪个版本完全移除。
3. service override 第一阶段是否允许覆盖 `authService`，还是只开放 `baseURL`、middleware、fetch 和重试配置。
4. manifest 是否作为默认提交文件，还是只用于 `--check` 内部比较。
5. 遗留 `legacyAllSchemas` 兼容开关默认关闭后，需要保留到哪个发布版本。

这些决策应写入本文并附带测试，不通过口头约定长期保留。
