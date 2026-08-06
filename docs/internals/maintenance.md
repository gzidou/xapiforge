# 维护入口

这页给第一次接手仓库的人使用。先确认仓库健康，再根据改动范围进入对应文档。不要从发布脚本或某个历史设计文档反推当前行为；代码、测试和本页列出的命令才是当前基线。

## 第一次接手

```bash
git status --short --branch
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm verify
```

要求：

- Node.js 20.19+，维护和 CI 推荐 Node.js 24。
- pnpm 9.x。
- `git status` 没有不明改动。
- `pnpm verify` 完整通过。不要只看最后一条命令；中间任一步失败都会返回非零退出码。

## 仓库怎么分

| 目录                      | 维护内容                               |
| ------------------------- | -------------------------------------- |
| `packages/core`           | HTTP、鉴权、middleware、错误和重试     |
| `packages/genapi`         | 配置、OpenAPI 下载、代码生成和两个 CLI |
| `packages/adapter-*`      | 不同运行环境的 TokenStore 或原生能力   |
| `packages/vconsole-debug` | 可选的业务诊断面板                     |
| `examples/demo-app`       | Vue 接入示例和浏览器回归页             |
| `scripts/test`            | 库级、浏览器和原生下载验证             |
| `docs`                    | VitePress 文档源文件                   |

## 改完以后跑什么

最稳妥的做法是提交前运行一次：

```bash
pnpm verify
```

开发过程中可以先跑较小范围：

| 改动                         | 先跑                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `packages/core`              | `pnpm --filter '@xapiforge/core' typecheck && pnpm test:scenarios` |
| `packages/genapi`            | `pnpm test:genapi`                                                 |
| `packages/vconsole-debug`    | `pnpm --filter '@xapiforge/vconsole-debug' test`                   |
| `adapter-capacitor` 下载逻辑 | `pnpm test:download`                                               |
| 文档或 VitePress 配置        | `pnpm docs:build`                                                  |
| demo 页面                    | 先启动 mock 和 demo，再运行 `pnpm test:demo-app`                   |

完整范围和期望结果见[验证指南](./validation.md)。

## 发布一个新版本

发布不是“运行一次 npm publish”。维护者需要依次完成版本号、CHANGELOG、验证、试装、正式发布和 Git tag。

```bash
pnpm release:version 0.1.5
pnpm verify
pnpm publish:dry-run
```

上面的版本号只是示例。完整步骤、2FA / 安全密钥说明和中途失败后的恢复方式见[npm 发布手册](./publishing.md)。没有得到明确授权时，不要执行 `pnpm publish:npm`。

## 发布文档

文档源文件只改 `main` 分支的 `docs/`。推送 `main` 后，`Docs` workflow 会构建站点并更新 `gh-pages` 分支。正常情况下不手工修改 `gh-pages`。

部署方式、检查命令和 2026-08-06 的故障记录见[文档站部署手册](./docs-deployment.md)。

## CI 应该看到什么

`CI` workflow 在 pull request 和 `main` 推送时运行五类检查：

- ESLint
- Prettier
- 包构建和根脚本类型检查
- 包测试、场景回归和原生下载测试
- VitePress 文档构建

`Docs` workflow 负责发布文档，不代替 CI。某次 GitHub Pages 发布失败时，先看 workflow 日志，再决定是否改代码。

## 几条不能破坏的约定

- 根包保持 `private: true`，只发布 `packages/*` 中列出的六个包。
- 业务后端的特殊 envelope 或 Swagger 修正放在 middleware / genapi hooks，不写进通用内核。
- adapter 不替业务项目锁定 Capacitor 或 React Native 原生依赖版本。
- npm 包不发布 source map；发布前用 dry-run 检查文件清单。
- 不提交 npm token、`.npmrc` 真实凭据、内部地址或业务数据。
- 修改公共行为时同步更新测试、接入文档和 `CHANGELOG.md`。
