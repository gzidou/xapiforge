# 枚举生成

标准 OpenAPI enum 默认仍由 openapi-typescript 生成 literal union。页面需要运行时常量、Options、label、颜色或图标时，在对应 service 显式启用 `createRuntimeEnumHooks`；后端非标准格式先由业务 `preprocessSwagger` 规范化。

## 标准输入

```json
{
  "type": "integer",
  "enum": [0, 1],
  "x-enum-varnames": ["Offline", "Online"],
  "x-enum-labels": ["离线", "在线"]
}
```

`enum` 是真实请求/响应值，`x-enum-varnames` 是代码成员名，`x-enum-labels` 是默认页面文案。三者长度必须一致；没有 labels 时回退到 varname。

## 页面 metadata 配置

```ts
import { createRuntimeEnumHooks } from "@xapiforge/genapi";

const enumHooks = createRuntimeEnumHooks({
  metadata: {
    "Sample.DeviceState": {
      // 按真实 enum value 覆盖业务文案和代码成员名。
      overrideLabels: { 0: "未连接", 1: "已连接" },
      overrideVarnames: { 1: "Connected" },

      // 后端 Swagger 确实缺值时显式补充；冲突直接失败。
      appendValues: [{ name: "Unknown", label: "未知状态", value: 2 }],

      // 通用页面属性，不写死 color/icon，也可以配置 tagType、badge、unit 等。
      extensions: {
        colors: { 0: "#999", 1: "#16a34a", 2: "#f59e0b" },
        icon: { 0: "WifiOff", 1: "Wifi" },
        presentation: {
          0: { tone: "muted", order: 2 },
          1: { tone: "positive", order: 1 }
        }
      },

      // 数字 enum 实际按字符串传输时生成转换映射；普通接口不要配置。
      serializeAs: "string"
    }
  }
});
```

metadata 支持：

- `overrideLabels`：修改页面 label；
- `overrideVarnames`：修改 TypeScript 成员名；
- `appendValues`：补充 Swagger 缺失的值，并同步进入 schema union；
- `extensions`：按 value 配置任意 JSON 页面属性；
- `serializeAs`：为数字枚举生成字符串序列化/反序列化映射；
- `isFlags`：Flags schema 的接口类型保持 `number`。

配置只应放在确实包含目标 schema 的 service hook 上。这样拼错的 full schema name 会立即失败，不会在多服务项目里静默失效。

## 生成产物

原始 service 类型文件生成：

```ts
export const SampleDeviceState = {
  Offline: 0,
  Connected: 1,
  Unknown: 2
} as const;

export type SampleDeviceStateValue = (typeof SampleDeviceState)[keyof typeof SampleDeviceState];

export const SampleDeviceStateLabels = {
  [SampleDeviceState.Offline]: "未连接",
  [SampleDeviceState.Connected]: "已连接",
  [SampleDeviceState.Unknown]: "未知状态"
} as const;

export const SampleDeviceStateOptions = [
  { key: "Offline", value: SampleDeviceState.Offline, label: "未连接" },
  { key: "Connected", value: SampleDeviceState.Connected, label: "已连接" },
  { key: "Unknown", value: SampleDeviceState.Unknown, label: "未知状态" }
] as const;

export type SampleDeviceStateOption = (typeof SampleDeviceStateOptions)[number];

export const SampleDeviceStateColors = {
  [SampleDeviceState.Offline]: "#999",
  [SampleDeviceState.Connected]: "#16a34a",
  [SampleDeviceState.Unknown]: "#f59e0b"
} as const;

export const SampleDeviceStateIcon = {
  [SampleDeviceState.Offline]: "WifiOff",
  [SampleDeviceState.Connected]: "Wifi",
  [SampleDeviceState.Unknown]: null
} as const;
```

还会生成 Names、ByLabel、`getXxxLabel()`、`getXxxName()`；`serializeAs: "string"` 时生成 Serialize、Deserialize 和转换函数。extension 缺失值固定补 `null`，对象 key 会稳定排序，值必须是有限、无循环的 JSON。

## 跟随 namespace

runtime enum 与 schema 使用同一套 service、prefix、显式 alias 和 `flat-strict` 规则。类型和值可以同名：

```ts
type State = BaseSchemas.DeviceState;
const state: State = BaseSchemas.DeviceState.Connected;
const options = BaseSchemas.DeviceStateOptions;
const color = BaseSchemas.DeviceStateColors[state];
const icon = BaseSchemas.DeviceStateIcon[state];
```

命中前缀 namespace 后整组产物一起移动：

```ts
const options = FillCenterSchemas.ReportStatistics.StatusOptions;
```

`flat-strict` 在 project 顶层或其 prefix namespace 提供同样产物。`canonical-only` 不生成便利短名，使用稳定注册表：

```ts
const state = RuntimeEnumsByService.base["Sample.DeviceState"].value.Connected;
const options = RuntimeEnumsByService.base["Sample.DeviceState"].options;
```

新增 enum 的 Options/Labels 不会移动其它 schema 或其它 enum 的导出；若新名称与现有 schema、namespace 或扩展产物碰撞，生成会在事务写盘前失败。

## 不重新读取 Swagger

```text
original Swagger
  → preprocessSwagger（业务 legacy 规范化）
  → metadata override/append 合并一次
  → normalizedDocument（深度冻结）
  ├─ openapi-typescript
  ├─ schema/namespace inventory
  └─ transformTypes 生成 runtime enum
```

`transformTypes` 只读取 `ctx.normalizedDocument` 和创建 hook 时的 metadata 快照，不读取 `ctx.swaggerPath`，也不重新执行 preprocess。这样 label、schema union、Options 和扩展映射来自同一份权威数据，并发生成多个 service 时不会串数据。

## Flags

```ts
createRuntimeEnumHooks({
  metadata: {
    "Sample.AccessMode": { isFlags: true }
  }
});
```

Flags 的 OpenAPI 字段生成 `number`，runtime const/Options 仍只列出 Swagger 声明的基础成员，并额外生成 `XxxMember`。组合值由业务代码按位计算：

```ts
const combined: number = AccessMode.Read | AccessMode.Execute;
```

## legacy enum

下面不是合法的标准数字 enum：

```json
{ "type": "integer", "enum": ["Offline(离线)=0", "Online(在线)=1"] }
```

业务 normalizer 应整体、保守地转换为数字 enum + varnames + labels，再交给通用 helper：

```ts
export const legacyEnumHooks = createRuntimeEnumHooks({
  preprocessSwagger: swagger => Promise.resolve(normalizeLegacyIntegerEnums(swagger)),
  metadata: {
    "Fixture.LegacyPermissions": { isFlags: true }
  }
});
```

可运行示例见 `examples/demo-app/hooks/legacy-enum.ts`。框架特有解析仍属于业务 hook，通用 helper 只处理规范化后的标准 enum 和明确 metadata。

## 失败边界

生成前严格检查：

- metadata full schema name、override/extension value 必须存在；
- append value 类型必须与 schema 一致，且不能与已有值冲突；
- varname 必须是非保留 TypeScript 标识符，name/value 不能重复；
- extension 名转换后的导出名不能互相碰撞，也不能覆盖 Labels/Options 等内置产物；
- extension 只能包含确定性 JSON；
- runtime enum 导出不能与同 namespace 的 schema 或 prefix namespace 冲突；
- `serializeAs: "string"` 只允许数字枚举。

任一失败都会中止整个 project，正式输出目录保持上一次有效结果。
