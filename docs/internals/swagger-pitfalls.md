# 典型 ABP Swagger 问题分析（业务侧 hooks 处理参考）

> 本文梳理 ABP 后端生成的 swagger 中常见的不规范形态，供业务侧编写 [genapi hooks](../guides/genapi-hooks.md) 时参考。
>
> **定位**：xapiforge 是通用工具，**内核只处理规范 OpenAPI**。ABP 等后端框架的特殊形态不属于内核职责，业务侧通过 genapi hooks 自定义处理。本文是「问题清单」而非「内核待办」。

## 一、问题全景

| #   | 问题                                                   | 典型频率 | 类型正确性    | openapi-typescript 默认行为  | 业务侧处理方式（via hooks）                                                                 |
| --- | ------------------------------------------------------ | -------- | ------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | 枚举 B 类 `"Alpha(选项一)=1"` 字符串描述               | 高       | ❌ 破坏       | 出字符串 union，与运行时矛盾 | transformSwagger 规范化 + transformTypes 追加 enum map（见 [枚举方案](../guides/enums.md)） |
| 2   | 枚举 A 类纯数字无 name                                 | 中       | ✅ 但魔法数字 | 出数字 union，能用但可读性差 | transformTypes 生成 items（无 key），业务 meta 补全                                         |
| 3   | `nullable: true`（OpenAPI 3.0 风格）                   | 极高     | ⚠️ 看实现     | v7 自动处理 → `T \| null`    | 无需处理                                                                                    |
| 4   | `Volo.Abp.*` schema 污染                               | 极高     | ⚠️ 类型膨胀   | 全部生成，类型文件臃肿       | transformSwagger 过滤 schema 白名单                                                         |
| 5   | `/api/abp/*` 系统端点泄漏                              | 高       | ⚠️ 噪声       | 生成 client 方法             | transformSwagger 过滤 paths 黑名单                                                          |
| 6   | `extraProperties: { additionalProperties: {} }` 空字典 | 高       | ⚠️ 过严       | 出 `Record<string, never>`   | transformSwagger 改 `additionalProperties: true`                                            |
| 7   | `concurrencyStamp` 乐观锁字段                          | 中       | ✅            | 出 `string \| null`          | 无需处理（业务契约）                                                                        |
| 8   | `format: int64`（long）JS 精度                         | 中       | ⚠️ JS 精度    | 出 `number`，超 2^53 丢精度  | transformSwagger 改 `type: string`（需 net 配合解析）                                       |
| 9   | `format: date-time`                                    | 高       | ✅            | 出 `string`（ISO 8601）      | 无需处理                                                                                    |
| 10  | `additionalProperties: false`                          | 中       | ✅            | 不出索引签名（更严格）       | 无需处理                                                                                    |

---

## 二、问题 1:枚举 B 类字符串描述

### 现象

```json
{
  "Example.Sample.State": {
    "type": "integer",
    "format": "int32",
    "enum": ["Alpha(选项一)=1", "Beta(选项二)=2"]
  }
}
```

### 根因

ABP / Swashbuckle 配置 `DescribeAllEnumsAsStrings: true` + `StringEnumConverter`，把枚举序列化成 `"Name(Description)=Value"` 形态。但 `type` 字段仍是 `integer`，违反 OpenAPI 规范（`enum` 值类型必须与 `type` 一致）。

### 影响

openapi-typescript 出 `"Alpha(选项一)=1" | "Beta(选项二)=2"`，TS 说传字符串，但后端收发数字。业务侧必须 `as any`，类型保护失效。

### 业务侧处理（via hooks）

**Hook 2 `transformSwagger`**：正则 `^([A-Za-z_][\w]*)\(([^)]*)\)=(\d+)$` 拆出 key/label/value，改写为 `enum: [1,2]` + `x-enum-varnames` + `x-enum-labels`。

**Hook 3 `transformTypes`**：扫规范化后的 swagger 生成 `enums/<svc>.ts` runtime map。

详见 [枚举方案](../guides/enums.md)。

---

## 三、问题 2:枚举 A 类纯数字无 name

### 现象

```json
{
  "MessageType": {
    "type": "integer",
    "enum": [0, 1, 2, 3, 4, 5]
  }
}
```

### 根因

后端 enum 没加 `[Description]` 特性，Swashbuckle 直接出数字。swagger 里**没有 key 信息**。

### 影响

类型正确（`0 | 1 | 2 | 3 | 4 | 5`），但业务侧 `if (msg.type === 2)` 是魔法数字。

### 业务侧处理（via hooks）

**Hook 3 `transformTypes`**：仍生成 `MessageTypeEnum = { items: [{ value: 0 }, ...] }`，但 key/label 缺失。

**业务 meta 文件**：用 `Record<number, { key, label }>` 补全。genapi **无法自动补 key**（信息不在 swagger 里）。

---

## 四、问题 3:`nullable: true`

### 现象

几乎所有引用类型字段都带 `"nullable": true`。

### 根因

OpenAPI 3.0 用 `nullable: true` 表示可空，3.1 改用 `type: ["string", "null"]`。ABP 默认输出 3.0 风格。

### 影响

openapi-typescript v7 自动处理 → `string | null`。**类型正确，无需处理**。

### 业务侧处理

无需处理。后端升级到 OpenAPI 3.1 后 `nullable` 字段消失，openapi-typescript 也能识别 3.1 写法。

---

## 五、问题 4:`Volo.Abp.*` schema 污染

### 现象

`components.schemas` 里有大量 `Volo.Abp.*` 命名空间的 schema（`ApplicationApiDescriptionModel`、`RemoteServiceErrorResponse` 等）。这些是 ABP 框架内部 metadata API 暴露的类型，**不是业务类型**。

### 根因

ABP 默认把所有 controller（包括框架自带的 `AbpApiDefinitionController` 等）注册到 swagger，其返回类型被 dump 进 `components.schemas`。

### 影响

- 类型文件膨胀：`types/<svc>.ts` 多出几十个 `Volo.Abp.*` 定义
- IDE 自动补全噪声：跳出框架内部类型
- 构建慢：openapi-typescript 处理所有 schema

### 业务侧处理（via hooks）

**Hook 2 `transformSwagger`**：删掉 `components.schemas` 里 key 以 `Volo.Abp.` 开头的 schema。引用侧 `$ref` 改成 `unknown` 或删字段。

```ts
// 业务侧 hook 示例（非内核代码）
transformSwagger(json, ctx) {
  const schemas = json.components?.schemas;
  if (schemas) {
    for (const key of Object.keys(schemas)) {
      if (key.startsWith("Volo.Abp.")) delete schemas[key];
    }
  }
}
```

---

## 六、问题 5:`/api/abp/*` 系统端点泄漏

### 现象

每个 swagger 的 `paths` 里都有 ABP 框架端点：

- `/api/abp/api-definition`
- `/api/abp/application-configuration`
- `/api/abp/application-localization`
- `/api/abp/multi-tenancy/tenants/by-name/{name}`
- `/api/abp/multi-tenancy/tenants/by-id/{id}`

### 根因

ABP 默认注册这些框架 controller。

### 影响

业务侧 `api.GET("/api/abp/...")` 能调通但**不应该调**（框架内部 API，版本升级后可能变更）。生成的 client 有这些方法，造成噪声。

### 业务侧处理（via hooks）

**Hook 2 `transformSwagger`**：删掉 `paths` 里 key 以 `/api/abp/` 开头的端点。

```ts
// 业务侧 hook 示例
transformSwagger(json, ctx) {
  const paths = json.paths;
  if (paths) {
    for (const path of Object.keys(paths)) {
      if (path.startsWith("/api/abp/")) delete paths[path];
    }
  }
}
```

---

## 七、问题 6:`extraProperties: { additionalProperties: {} }` 空字典

### 现象

ABP DTO 基类 `ExtensibleEntity` 自带 `extraProperties` 字段：

```json
"extraProperties": {
  "type": "object",
  "additionalProperties": {},
  "nullable": true
}
```

### 影响

openapi-typescript 出 `Record<string, never> | null`（`additionalProperties: {}` 被解释成"不接受任何属性"）。**类型过严**，`dto.extraProperties.foo` TS 报错。

### 业务侧处理（via hooks）

**Hook 2 `transformSwagger`**：把 `additionalProperties: {}` 改成 `additionalProperties: true`，openapi-typescript 出 `Record<string, unknown>`。

---

## 八、问题 7:`concurrencyStamp` 乐观锁字段

### 现象

ABP 实体基类 `IHasConcurrencyStamp` 自带 `concurrencyStamp: string nullable`。

### 影响

类型正确。业务侧 PUT 时需把 GET 拿到的 `concurrencyStamp` 原样回传（乐观锁契约）。

### 业务侧处理

无需处理。这是 ABP 的业务契约，不应过滤。文档里提醒业务侧："PUT 实体时记得透传 `concurrencyStamp`"。

---

## 九、问题 8:`format: int64` JS 精度问题

### 现象

后端 `long` 字段（如 Snowflake ID）：

```json
"id": { "type": "integer", "format": "int64" }
```

### 影响

C# `long` 是 64 位，JS `number` 只有 53 位精度。超过 `2^53 - 1` 的 ID 会丢精度，PUT 时回传错误 ID 导致更新错记录。

### 业务侧处理（via hooks + net 配合）

**Hook 2 `transformSwagger`**：把 `format: int64` 的字段 `type` 改成 `string`。

**net 包配合**：响应解析需用支持大数字符串的 JSON 解析器（构建时 + 运行时协同）。

```ts
// 业务侧 hook 示例
transformSwagger(json, ctx) {
  const walk = (schema: any) => {
    if (schema?.format === "int64") {
      schema.type = "string";
      delete schema.format;
    }
    for (const k of Object.keys(schema ?? {})) {
      if (typeof schema[k] === "object") walk(schema[k]);
    }
  };
  // 遍历 schemas 和 paths
}
```

---

## 十、问题 9/10:`date-time` / `additionalProperties: false`

### 问题 9:`format: date-time`

openapi-typescript 出 `string`（ISO 8601）。类型正确，业务侧需自己 `new Date(str)`。无需处理。

### 问题 10:`additionalProperties: false`

openapi-typescript 不出索引签名（类型更严格）。是好事，无需处理。

---

## 十一、处理优先级

| 优先级 | 问题                   | 处理方式                                          | Hook       |
| ------ | ---------------------- | ------------------------------------------------- | ---------- |
| **P0** | 问题 1 枚举 B 类       | transformSwagger 规范化 + transformTypes 追加 map | Hook 2 + 3 |
| **P0** | 问题 4 Volo.Abp schema | transformSwagger 过滤                             | Hook 2     |
| **P0** | 问题 5 /api/abp/* 端点 | transformSwagger 过滤                             | Hook 2     |
| **P1** | 问题 8 int64 精度      | transformSwagger 改类型 + net 配合                | Hook 2     |
| **P2** | 问题 2 枚举 A 类       | transformTypes + 业务 meta                        | Hook 3     |
| **P2** | 问题 6 extraProperties | transformSwagger 改 additionalProperties          | Hook 2     |
| **P3** | 问题 3/7/9/10          | 无需处理                                          | -          |

---

## 十二、genapi hooks 机制

上述所有「业务侧处理」均通过 genapi hooks 实现，详见 [genapi hooks 设计](../guides/genapi-hooks.md)。

hooks 体系提供 6 个插入点覆盖完整生成流程：

```
download → [Hook 1] → disk → [Hook 2 主钩子] → openapi-typescript → [Hook 3] → types.ts
                                                                              ↓
                                              [Hook 4] ← api-types.ts ← render
                                                                              ↓
                                              [Hook 5] ← index.ts ← render
                                                                              ↓
                                              [Hook 6] ← onComplete
```

**关键设计**：

- Hook 2 (`transformSwagger`) 是主钩子——所有 swagger 定制在此完成
- 内核不硬编码任何 ABP / SpringBoot / NestJS 特殊逻辑
- 业务侧在 `xapiforge.config.ts` 中配置 hooks，下载脚本和 generate 共用

---

## 十三、验证策略

### 13.1 单测

业务侧为自己的 hooks 编写单测，构造最小 swagger fixture：

```
test/fixtures/
├── enum-B.json          # 问题 1
├── enum-A.json          # 问题 2
├── volo-abp-schema.json # 问题 4
├── abp-paths.json       # 问题 5
├── int64.json           # 问题 8
└── extra-props.json     # 问题 6
```

### 13.2 集成验证

业务侧在自己的 app 项目中跑 `pnpm generate:api`，diff 产物：

- `types/` 文件大小应显著缩小（问题 4 过滤后）
- `enums/` 新目录生成（问题 1/2）
- `api-types.ts` 不再出现 `Volo.Abp.*` alias（问题 4）
- client 不再有 `/api/abp/*` 方法（问题 5）

### 13.3 回归

在 `examples/demo-app/` 跑 `pnpm generate:api`，确认 demo-app 的人造 swagger 不受 hooks 影响（demo-app 不配置 hooks 时产物不变）。

---

## 十四、与其他分类后端框架的类比

ABP 的问题模式在其他分类后端框架中也有类似表现：

| 后端框架               | 类比问题                      | 对应 hook                                  |
| ---------------------- | ----------------------------- | ------------------------------------------ |
| SpringBoot             | `Page<T>` 包装类型膨胀        | transformSwagger 展开/替换泛型 schema      |
| SpringBoot             | `Map<String, Object>` 丢类型  | transformSwagger 补 `additionalProperties` |
| NestJS                 | 自定义 decorator 的 `x-` 扩展 | transformSwagger 提取/转换                 |
| GraphQL → OpenAPI 转换 | 类型名冲突                    | transformSwagger 重命名                    |

**核心思路一致**：内核处理规范 OpenAPI，框架特殊形态走 hooks。
