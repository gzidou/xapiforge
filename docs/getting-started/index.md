# 选择接入方式

xapiforge 的代码生成方式在各运行环境中相同。真正不同的是 Token 存储、网络实现和文件下载能力。先按应用运行位置选择指南，不需要把三个 adapter 都装上。

| 运行环境                  | 使用的 adapter                    | 从这里开始                                     |
| ------------------------- | --------------------------------- | ---------------------------------------------- |
| Vue、React、普通 Web 应用 | `@xapiforge/adapter-browser`      | [浏览器应用接入](./browser.md)                 |
| Ionic / Capacitor         | `@xapiforge/adapter-capacitor`    | [Ionic / Capacitor 接入](./ionic-capacitor.md) |
| React Native              | `@xapiforge/adapter-react-native` | [React Native 接入](./react-native.md)         |

使用 AI 编程工具接入时，可以安装仓库提供的 `xapiforge-integration` Skill。安装和调用方法见[使用 AI 接入](./ai-integration.md)。Skill 会先识别接入项目，不会替你猜测 OpenAPI 地址或认证协议。

## 所有项目都要完成的四件事

1. 安装 `@xapiforge/core`、`@xapiforge/genapi` 和一个运行时 adapter。
2. 创建 `xapiforge.config.ts`，配置 OpenAPI 地址和生成目录。
3. 执行 `xapiforge-fetch` 和 `xapiforge`，得到强类型客户端。
4. 创建 `AuthService`，把它和对应的 TokenStore 传给生成客户端。

生成客户端以后，业务代码只使用生成结果，例如：

```typescript
const { data } = await api.base.GET("/api/health");
```

路径、参数和返回值来自项目自己的 OpenAPI 文档。文档中的 `/api/health`、端口和 OAuth 字段只是示例，接入时要替换成真实后端协议。

## 只是想先看效果

仓库中的 `examples/demo-app` 可以直接连接本地 mock-server：

```bash
pnpm install
pnpm mock
pnpm --filter '@xapiforge/example-demo-app' dev
```

打开 `http://localhost:5173`。这个 demo 用于理解调用方式和运行回归场景，不应原样复制成业务项目。

## 生成文件是否提交到 Git

两种方式都可以，但团队只能选一种：

- 提交生成文件：代码审查能看到 API 变化，仓库会出现较大的生成 diff。
- 构建时生成：仓库更干净，但 CI 必须能拿到固定版本的 OpenAPI 文档。

如果后端文档会随环境变化，建议把审核过的 swagger.json 和生成结果一起提交，避免同一个前端提交在不同时间生成不同代码。
