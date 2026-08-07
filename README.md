# xapiforge

[![CI](https://github.com/gzidou/xapiforge/actions/workflows/ci.yml/badge.svg)](https://github.com/gzidou/xapiforge/actions/workflows/ci.yml)
[![npm: @xapiforge/core](https://img.shields.io/npm/v/%40xapiforge%2Fcore)](https://www.npmjs.com/package/@xapiforge/core)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://gzidou.github.io/xapiforge/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

xapiforge 根据 OpenAPI 文档生成 TypeScript 客户端，并统一处理鉴权、重试、错误和业务 middleware。核心代码不依赖 Vue、React 等 UI 框架，同一套客户端可以用在浏览器、Ionic / Capacitor 和 React Native 项目中。

完整文档：[https://gzidou.github.io/xapiforge/](https://gzidou.github.io/xapiforge/)

## 先选需要的包

| 包                                | 什么时候使用                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| `@xapiforge/core`                 | 必选。提供 `HttpClient`、`AuthService`、`createNet` 和 middleware |
| `@xapiforge/genapi`               | 开发依赖。下载 OpenAPI 文档并生成 TypeScript 客户端               |
| `@xapiforge/adapter-browser`      | 浏览器项目的 localStorage、sessionStorage 和 cookie TokenStore    |
| `@xapiforge/adapter-capacitor`    | Capacitor 的 TokenStore 和原生文件下载                            |
| `@xapiforge/adapter-react-native` | React Native 的 Keychain / EncryptedStorage TokenStore            |
| `@xapiforge/vconsole-debug`       | 可选的移动端业务诊断面板                                          |

不要一次安装所有 adapter。按照应用的运行环境选择一个即可。

## 浏览器项目快速接入

下面以已有的 Vue、React 或其他浏览器项目为例。项目需要 Node.js 20.19+、pnpm 9+，并且后端可以提供 OpenAPI 3.x 文档。

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser
pnpm add -D @xapiforge/genapi
```

在项目根目录创建 `xapiforge.config.ts`：

```typescript
import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  defaultPath: "/swagger/v1/swagger.json",
  timeoutMs: 15_000,
  outputDir: "swagger",
  genOutputDir: "src/api",
  mode: "online",
  projects: [
    {
      name: "myapp",
      displayName: "My Application",
      baseHost: "http://localhost:7001",
      services: [{ name: "base", displayName: "Base API", port: 7001 }]
    }
  ]
});
```

在应用的 `package.json` 中加入：

```json
{
  "scripts": {
    "download-swagger": "xapiforge-fetch",
    "generate:api": "xapiforge"
  }
}
```

然后生成客户端：

```bash
pnpm download-swagger
pnpm generate:api myapp
```

下一步按[浏览器应用接入](https://gzidou.github.io/xapiforge/getting-started/browser)创建 `AuthService` 并初始化生成的客户端。Capacitor 和 React Native 项目先看[接入方式选择](https://gzidou.github.io/xapiforge/getting-started/)；它们的代码生成步骤相同，只是网络和 TokenStore 适配方式不同。

## 使用 AI 接入

仓库提供 [`xapiforge-integration` Skill](./.agents/skills/xapiforge-integration/SKILL.md)，帮助 AI 先识别接入项目，再完成依赖选择、客户端生成、鉴权连接和验证。安装与调用方式见[使用 AI 接入](./docs/getting-started/ai-integration.md)。

## 示例项目

`examples/demo-app` 是 Vue 3 示例，同时承载浏览器回归场景：

```bash
pnpm install
pnpm mock
pnpm --filter '@xapiforge/example-demo-app' dev
```

浏览器打开 `http://localhost:5173`。场景说明见[验证指南](https://gzidou.github.io/xapiforge/internals/validation)。

## 参与开发与维护

第一次拉取仓库：

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` 会运行构建、类型检查、格式检查、lint、包测试、场景回归、原生下载测试和文档构建。提交前应保证它完整通过。

- [贡献说明](./CONTRIBUTING.md)
- [维护入口](./docs/internals/maintenance.md)
- [npm 发布手册](./docs/internals/publishing.md)
- [文档站部署手册](./docs/internals/docs-deployment.md)
- [版本记录](./CHANGELOG.md)

## License

[MIT](./LICENSE)
