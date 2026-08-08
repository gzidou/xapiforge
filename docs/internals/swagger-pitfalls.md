# 非规范 OpenAPI 问题分类与处理边界

本文供接入 ABP、Spring Boot、NestJS 或历史服务时排查 OpenAPI 使用。它不是框架规则大全，也不是 xapiforge 内核待办。

xapiforge 内核处理规范、自包含的 OpenAPI 3.x。只有已经通过实际请求/响应确认的服务差异，才由业务侧 service hook 保守规范化。完整接入顺序见[多后端与非规范 OpenAPI 接入](../getting-started/multi-backend.md)。

## 先按层分类

| 现象                                                         | 风险                                | 正确处理                                             |
| ------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------- |
| OpenAPI 2、非法对象、无法解析或外部 `$ref`                   | 无法确定生成输入                    | 修复/预处理为自包含 OpenAPI 3.x                      |
| enum 值类型与 schema type 不一致                             | 生成类型与真实值可能相反            | 对照真实 JSON，service `preprocessSwagger` 整体转换  |
| enum 只有数字、没有成员名                                    | 类型正确但页面只能写魔法数字        | 用经过审核的业务映射补 `x-enum-varnames/labels`      |
| `nullable: true`、`date-time`、`additionalProperties: false` | 通常是合法 OpenAPI 3.0 语义         | 先保留并检查生成类型，不要为了“看起来复杂”改写       |
| 框架内部 path/component                                      | 补全噪声或暴露不应调用的 API        | 优先让后端生成业务文档；否则精确过滤 path 并验证引用 |
| `additionalProperties: {}` 与实际任意对象不符                | 可能生成过严字典                    | 确认运行时后改为 `additionalProperties: true`        |
| `int64` 实际以 JSON number 发送                              | 超过 53 位后运行时已丢精度          | 后端改为字符串序列化并同步 OpenAPI                   |
| 跨 service 同名 schema                                       | 不是错误                            | 保持独立 service namespace，不合并 Swagger           |
| 缺少 `operationId` 或 tags                                   | 可读性较差，但 path/method 仍可生成 | 可推动后端改善；通常不需要 hook                      |
| 业务 `{ code, data }` envelope                               | 运行时响应协议                      | middleware，不是生成 hook                            |
| CORS、证书、代理或主机错误                                   | 运行环境问题                        | 网络层、代理或 client `baseURL`                      |

## legacy integer enum

### 现象

schema 声明 integer，enum 却是带说明的字符串：

```json
{
  "type": "integer",
  "enum": ["Alpha(选项一)=1", "Beta(选项二)=2"]
}
```

这违反 enum 值必须与 schema type 一致的约束。先通过真实响应确认后端确实发送 `1/2`，再规范化为：

```json
{
  "type": "integer",
  "enum": [1, 2],
  "x-enum-varnames": ["Alpha", "Beta"],
  "x-enum-labels": ["选项一", "选项二"]
}
```

使用 `createRuntimeEnumHooks({ preprocessSwagger, metadata })`，让 schema union、运行时 const、Options、label 和页面扩展共享同一份 normalized document。可复制的保守解析器见[多后端接入示例](../getting-started/multi-backend.md#保守处理-legacy-enum)。

处理原则：

- 从字符串末尾解析实际值，允许 label 中包含普通括号或等号；
- 只有整个 enum 都能解析时才转换；
- value 必须是安全整数且不能重复；
- name 必须是合法、非保留的 TypeScript 标识符且不能重复；
- 无法识别时失败或保留原样，不能部分转换或猜默认值；
- 不修改磁盘上的原 Swagger。

### 只有数字，没有 name

```json
{ "type": "integer", "enum": [0, 1, 2] }
```

这里的 `0 | 1 | 2` 类型本身正确，但 OpenAPI 没有提供 `Pending/Running/Done` 等成员信息。生成器不能凭数字推断名称。

如果业务有权威映射，在目标 service 的 `preprocessSwagger` 中补齐：

```ts
schema["x-enum-varnames"] = ["Pending", "Running", "Done"];
schema["x-enum-labels"] = ["待处理", "处理中", "已完成"];
```

然后交给 `createRuntimeEnumHooks`。映射必须跟随业务代码审查；metadata 的 label 覆盖不能替代缺失的成员身份。

## nullable、日期和对象约束

### `nullable: true`

OpenAPI 3.0 使用 `nullable: true`，OpenAPI 3.1 通常使用包含 `null` 的类型。当前生成链可以处理规范输入。先检查生成结果是否为预期的 `T | null`，不要统一删除 nullable。

可空和可选是两件事：

- `nullable` 决定值能否为 `null`；
- `required` 决定属性能否缺失。

hook 不应把两者混成同一个规则。

### `format: date-time`

默认生成 `string`，因为 JSON 传输的是字符串。业务在边界处按需要解析 `Date`；不要把生成类型全局改成 `Date`，除非运行时解析也同步完成并经过验证。

### `additionalProperties: false`

表示对象不接受任意额外属性，通常应保留。它不是“类型缺字段”的自动修复目标。

### 空 `additionalProperties`

部分后端输出：

```json
{
  "type": "object",
  "additionalProperties": {}
}
```

如果实际响应允许任意 JSON 属性，而生成结果过严，可在目标 schema 上精确改为：

```json
{ "type": "object", "additionalProperties": true }
```

不要递归替换所有空 schema；空 schema 在 example、组合 schema 或其它位置可能有不同语义。

## 框架内部 path 和 component

ABP 常见 `/api/abp/*`，其它框架也可能暴露 actuator、metadata 或内部管理端点。若前端明确不应调用，可精确删除 path：

```ts
for (const path of Object.keys(document.paths)) {
  if (path.startsWith("/api/abp/")) delete document.paths[path];
}
```

删除 component 比删除 path 风险高。不要看到 `Volo.Abp.*`、`Page*` 或 `Internal*` 前缀就批量删除：

- 业务 path 可能仍通过 `$ref` 引用它；
- 把引用改成 `unknown` 会掩盖真实契约；
- 名称看起来像框架类型不代表运行时不会返回。

优先让后端提供只包含业务 controller 的 OpenAPI。如果必须裁剪 component，应使用可复现的引用可达性分析，并为保留/删除的 path、schema 和 `$ref` 完整性编写 fixture 测试。生成器会在写正式目录前拒绝悬空引用。

## int64 与 JS 精度

OpenAPI：

```json
{ "type": "integer", "format": "int64" }
```

若后端发送 JSON number，超过 `Number.MAX_SAFE_INTEGER` 后，JavaScript 在解析阶段已经失去精度。下面做法是错误的：

```ts
// 错误：只改变静态类型，运行时仍收到已经失真的 number。
schema.type = "string";
```

正确方案是后端把该字段按 JSON string 发送，并把 OpenAPI 同步为 `type: string`。前端确认实际响应已是字符串后，才可以用 service hook 修正尚未更新的文档，并记录这是临时兼容。

对数据库主键、雪花 ID、游标、版本号和金额最小单位尤其要检查实际序列化。

## OpenAPI 引用

xapiforge 要求生成输入自包含：语义位置的 `$ref` 必须是可解析的内部引用。以下情况会失败：

- 指向不存在 component 的内部 `$ref`；
- 文件或 HTTP 外部 `$ref`；
- 非法 JSON Pointer；
- `$ref` 指向不符合目标 OpenAPI 对象形态的值。

需要多文件维护时，在受控上游流程中固定版本并 bundle 成单一 OpenAPI，再把 bundle 结果作为 `source.file` 或 URL 缓存。不要让生成阶段临时访问未经锁定的外部引用。

example、default、Example Object 的 `value` 和 `x-*` 扩展内恰好叫 `$ref` 的业务字段按普通数据保留，不应由业务 hook 删除。

## 重复 schema 和命名冲突

不同 service 都包含 `Shared.Result`、`UserDto` 或框架公共 DTO 是正常情况。canonical identity 包含 project、service 和 full schema name：

```ts
type CatalogResult = SchemaOf<"catalog", "Shared.Result">;
type OrderResult = SchemaOf<"legacy-orders", "Shared.Result">;
```

默认便利入口分别是 `CatalogSchemas.Result` 和 `LegacyOrdersSchemas.Result`。不要合并 Swagger，也不要为跨 service 重复维护成百上千条 alias。

只有同一 service、同一 namespace 内的不同 full name 产生相同短名时才配置精确 alias。冲突诊断会列出两个完整 identity。

## 当前 hook 边界

当前公开两个 hook：

```text
读取原 Swagger
  → transformSwagger
  → 固定 normalizedDocument
  → openapi-typescript
  → transformTypes
  → 事务提交 types/index/api-types/manifest
```

- `transformSwagger`：返回新的规范化文档，不修改原文件；
- `transformTypes`：只根据 `typesContent` 和 `ctx.normalizedDocument` 追加确定性内容；
- runtime enum helper 在 `transformSwagger` 合并 metadata 一次，在 service 类型文件追加运行时导出，并在 `api-types.ts` 按 namespace 重导出；
- 当前没有 `transformDownloaded`、`transformApiTypes`、`transformIndex`、独立 `enums/` 目录或 `onComplete` hook。

root、project、service hook 使用整对象覆盖，优先级为 `service > project > root`；service 配置 `{}` 会显式禁用继承。

## 业务 hook 验证

每种异常准备最小、脱敏 fixture，不要把真实业务 Swagger 提交到工具仓库。至少验证：

1. 原 Swagger 文件保持不变；
2. 规范化后的类型与真实 JSON 值一致；
3. 任意一项无法识别时不会部分转换；
4. 删除 path/schema 后没有悬空 `$ref`；
5. endpoint、schema namespace、manifest 和 runtime enum 使用同一 normalized document；
6. enum const、Options、label 和页面扩展可由独立 TypeScript 消费者编译；
7. 错误配置在正式输出写入前失败，旧生成目录保持有效；
8. 第二次 `--check` 输出 `UNCHANGED`；
9. 改变一个 service 不会移动其它 service 的公开类型；
10. 至少观察一个真实或 mock 请求，确认运行时响应与生成类型一致。

不要在 hook 中写真实域名、凭据、当前时间、随机值或未锁定远程依赖。详细 API 见[genapi Hooks](../guides/genapi-hooks.md)和[枚举生成](../guides/enums.md)。
