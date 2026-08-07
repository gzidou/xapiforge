# 枚举生成

genapi 的默认规则很简单：标准 OpenAPI enum 交给 openapi-typescript 生成 literal union。运行时常量是显式 opt-in；非标准历史格式由业务 hook 先规范化。

## 标准 enum 是权威输入

数字 enum：

```json
{
  "type": "integer",
  "enum": [0, 1]
}
```

生成的 schema 类型是 `0 | 1`。字符串 enum 同理：

```json
{
  "type": "string",
  "enum": ["pending", "running"]
}
```

生成类型是 `"pending" | "running"`。genapi 不默认改成 TypeScript `enum`，也不改变真实序列化值。

## 显式生成 runtime map

当 schema 同时提供名称和可选 label：

```json
{
  "type": "integer",
  "enum": [0, 1],
  "x-enum-varnames": ["Offline", "Online"],
  "x-enum-labels": ["离线", "在线"]
}
```

在对应 service 上启用通用 helper：

```ts
import { createRuntimeEnumHooks, defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  // ...
  projects: [
    {
      name: "portal",
      displayName: "Portal",
      baseHost: "http://localhost:7001",
      services: [
        {
          name: "base",
          displayName: "Base API",
          port: 7001,
          hooks: createRuntimeEnumHooks()
        }
      ]
    }
  ]
});
```

除 `components["schemas"]` 的 literal union 外，`types/base.ts` 会追加：

```ts
export const DeviceState = {
  Offline: 0,
  Online: 1
} as const;

export type DeviceStateValue = (typeof DeviceState)[keyof typeof DeviceState];

export const DeviceStateLabels: Readonly<Record<DeviceStateValue, string>> = {
  [DeviceState.Offline]: "离线",
  [DeviceState.Online]: "在线"
} as const;
```

没有 `x-enum-labels` 时，label 回退到 varname。helper 会校验：

- enum 值与 OpenAPI `type` 一致；
- varname/label 数量与 enum 值数量一致；
- varname 是非保留的 TypeScript 标识符且不重复；
- enum 值不重复；
- 两个 schema 不会生成相同 runtime 导出名；
- metadata 引用的 schema 必须存在。

校验失败会中止整个 project，正式输出目录保持不变。

## Flags

Flags 可能返回组合值，例如 `Read | Execute = 5`。`1 | 2 | 4` 无法表达所有组合，因此必须显式标记：

```ts
hooks: createRuntimeEnumHooks({
  metadata: {
    "Sample.AccessMode": { isFlags: true }
  }
});
```

结果：

- `components["schemas"]["Sample.AccessMode"]` 是 `number`；
- `SampleAccessMode` 仍包含声明的 `Read: 1`、`Write: 2`、`Execute: 4`；
- `SampleAccessModeValue` 只描述声明值，不穷举组合；
- 组合由业务代码使用位运算。

```ts
const combined: components["schemas"]["Sample.AccessMode"] = SampleAccessMode.Read | SampleAccessMode.Execute;
```

## legacy enum

下面不是合法的标准数字 enum，因为 `type` 是 integer，值却是字符串：

```json
{
  "type": "integer",
  "enum": ["Offline(离线)=0", "Online(在线)=1"]
}
```

处理链路必须是：

```text
legacy Swagger
  → 业务 preprocessSwagger
  → 标准 enum + x-enum-varnames/x-enum-labels
  → openapi-typescript literal union
  → 可选 runtime map
```

仓库中的可运行示例是 `examples/demo-app/hooks/legacy-enum.ts`：

```ts
export const legacyEnumHooks = createRuntimeEnumHooks({
  preprocessSwagger: swagger => Promise.resolve(normalizeLegacyIntegerEnums(swagger)),
  metadata: {
    "Fixture.LegacyPermissions": { isFlags: true }
  }
});
```

示例 normalizer 采用保守策略：一个 schema 的所有值都能解析时才整体转换；任一值不符合格式就原样保留。复制到业务项目后，应按自己的真实协议调整正则和 metadata，并补 fixture 测试。

这段 legacy 规则不是 genapi 默认行为，也不假设 ABP、Spring Boot 或其它框架。

## 选择建议

| 需求                            | 做法                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| 只需要请求/响应类型             | 保持标准 enum，不启用 helper                                |
| UI 需要稳定常量和 label         | `createRuntimeEnumHooks()`                                  |
| Flags 可能出现组合值            | metadata 标记 `isFlags: true`                               |
| Swagger 格式不标准              | 业务 `preprocessSwagger` 先规范化                           |
| 后端真实收发值与 Swagger 不一致 | 优先修 Swagger；无法修时用业务 hook/middleware 并测试序列化 |

完整 hook 优先级和上下文见 [genapi Hooks](./genapi-hooks.md)，多服务配置见 [genapi v2](./genapi-v2.md)。
