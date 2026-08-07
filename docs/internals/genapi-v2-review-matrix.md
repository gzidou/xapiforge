# genapi v2 严格 review 矩阵

日期：2026-08-07

本文把 v2 的公开合同映射到实现和可重复验证，防止“文档提过、代码没实现”或“真实 Swagger 恰好没覆盖”被误判为完成。自动测试位于 `packages/genapi/test/`；真实和模拟消费项目位于 Git ignored 的 `tmp/dcenter-vue/`。

| 合同                                               | 正向验证                                                                               | 失败/边界验证                                                 | 消费项目证据                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| `source.file` 与 service ID 解耦                   | 非同名文件生成结果稳定；移动文件不漂移                                                 | file/url 同时配置、未知字段、非 JSON 路径被拒绝               | 6 个 PascalCase 原文件映射为稳定 kebab-case service ID          |
| `source.url` 是完整精确 URL                        | query 在内的 URL 原样请求；online 原子写缓存；offline 复用缓存                         | URL 凭证、非法协议、缺失离线缓存失败                          | CLI 测试另用本地 HTTP fixture，不依赖真实 dcenter 网络          |
| `--dry-run` 不访问 URL                             | 不可连接 URL 仍成功且不写缓存                                                          | 本地 file 在 dry-run 仍必须是有效 JSON                        | `fetch-cli-v2.test.js` 端到端覆盖                               |
| canonical identity = project + service + full name | `SchemasByService`、`SchemaOf` 编译                                                    | 跨 service 同 full name 不合并                                | real dcenter 的异构重复类型 + canonical 模拟双 service          |
| `service-namespace` 默认模式                       | 跨 service 重复短名分别编译                                                            | 同 service 同层短名冲突失败，显式 alias 可解除                | real dcenter：841 schemas、0 显式 alias                         |
| service 模式 prefix namespace                      | service 专属优先、最长前缀优先、规则重排不漂移                                         | 不存在 service、非法 namespace、同层 alias/namespace 冲突失败 | 真实匹配 `Business` 34 条、`ReportStatistics` 21 条             |
| `flat-strict` 正式模式                             | project 顶层 alias 和 prefix namespace 编译                                            | 跨 service 短名、canonical 名称、alias/namespace 冲突失败     | `mode-flat` 编译 `Catalog.ProductDto`、`InvoiceDto`、`PageInfo` |
| `canonical-only` 正式模式                          | 只编译 canonical API                                                                   | 同时配置 alias 或 namespace 被拒绝                            | `mode-canonical` 的同名异构 schema 仅按 alpha/beta 访问         |
| generic/空 schema 边界                             | generic full name 可由 `SchemaOf` 或显式 alias 访问；无 schema service 仍可编译        | 不根据不稳定 generic metadata 自动猜短名                      | 最小模拟测试，不依赖真实 Swagger 是否包含该形态                 |
| 无关后端变化不移动已有公开类型                     | schema 增加、删除、类型变化后稳定 import 和未变 schema 片段保持一致                    | 新碰撞会停止事务，不覆盖上次有效产物                          | `--check` 三项目均为 `UNCHANGED`                                |
| 配置和输入顺序不参与身份                           | service 顺序、JSON object key 顺序、prefix 规则顺序重排不漂移                          | 生成名称/runtime key 碰撞在配置阶段失败                       | manifest 不含 source、时间戳或绝对路径                          |
| 单次规范化与业务 hooks                             | 权威 document 深度冻结；第三方仅接收一次性 clone；alias、endpoint、manifest 读同一对象 | hook 后变异、external/unresolved `$ref`、不合法结果写盘前失败 | dcenter 的 45 个非标准 integer enum 由业务 hook 规范化          |
| 多项目原子性与可恢复性                             | staging、stale 清理、事务替换、只读 `--check`                                          | 任一项目准备失败则全部不写；中断事务下次恢复                  | 三个项目一次 `xapiforge all` 生成并检查                         |

## 稳定性解释

“稳定”不是隐藏真实后端变化：目标 schema 或其 `$ref` 依赖改变时，目标类型应当改变。保证的是未受影响 identity 不会因为输入顺序、来源位置、其他 service 或无关 schema 的变化而被重命名、移动或错误重绑定。

`flat-strict` 的新增碰撞属于受控失败：旧产物由事务机制保留，生成器不会把已有短名悄悄绑定到新 schema。需要业务显式配置唯一 alias 后再更新生成产物。

## 执行入口

```bash
pnpm --filter @xapiforge/genapi test
cd tmp/dcenter-vue
pnpm verify
```

`tmp/dcenter`、`tmp/dcenter-vue` 及其中的真实 Swagger、模拟 fixtures、生成代码、包文件和构建产物均由仓库根 `tmp/` 规则忽略，不得加入提交。
