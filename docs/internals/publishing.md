# npm 发布手册

本文给负责发版的人使用。xapiforge 采用人工确认发布：脚本负责按顺序检查和发布六个包，但不会替维护者决定版本号，也不会绕过 npm 的登录和双重验证。

正式发布会产生公开且不可复用的 npm 版本。没有明确发布授权时，只执行 dry-run。

## 会发布哪些包

根目录的 `xapiforge` 包保持 `private: true`。公开包只有：

| 顺序 | 包                                |
| ---- | --------------------------------- |
| 1    | `@xapiforge/core`                 |
| 2    | `@xapiforge/genapi`               |
| 3    | `@xapiforge/adapter-browser`      |
| 4    | `@xapiforge/adapter-capacitor`    |
| 5    | `@xapiforge/adapter-react-native` |
| 6    | `@xapiforge/vconsole-debug`       |

脚本按这个顺序执行，确保 adapter 发布前，新的 core 已经存在。

## 三种目标

| 命令                   | 是否上传 | 目标                                        |
| ---------------------- | -------- | ------------------------------------------- |
| `pnpm publish:dry-run` | 否       | 只打包并检查 npm 文件清单                   |
| `pnpm publish:local`   | 是       | 本地 registry，默认 `http://localhost:4873` |
| `pnpm publish:npm`     | 是       | 公共 `https://registry.npmjs.org/`          |

本地 registry 地址可以覆盖：

```bash
XAPIFORGE_LOCAL_NPM_REGISTRY=http://localhost:4873 pnpm publish:local
```

## 正式发版步骤

### 1. 确认分支和改动

```bash
git status --short --branch
git pull --ff-only
```

只从准备发布的 `main` 提交发版。先处理不明的本地改动，不要把临时文件混进版本提交。

### 2. 决定版本号

按照语义化版本选择：

- 修复兼容问题：patch，例如 `0.1.4` → `0.1.5`。
- 增加向后兼容能力：minor，例如 `0.1.4` → `0.2.0`。
- 有破坏性修改：major；项目仍处于 `0.x` 时，也必须在 CHANGELOG 明确写出迁移方式。
- 尚未稳定、需要限制默认安装人群：使用预发布版本，例如 `0.2.0-alpha.0`。发布脚本会从预发布标识自动选择 `alpha` dist-tag，不会移动 `latest`。

统一修改根包和六个公开包：

```bash
pnpm release:version 0.1.5
```

版本号只是示例。随后编辑 `CHANGELOG.md`，写清使用者能感知的变化、修复和兼容性影响。

预发布版本发布前必须确认 dry-run 头部同时显示预期版本与 tag，例如：

```text
version: 0.2.0-alpha.0
tag: alpha
```

如需覆盖自动选择结果，可直接调用发布脚本并显式传 `--tag`；不要给 alpha/beta/rc 版本使用 `latest`。

### 3. 跑完整门禁

```bash
pnpm verify
pnpm publish:dry-run
```

dry-run 输出的包中应有 `dist/*.js`、`dist/*.d.ts` 和包 README，不应有 source map、源码、测试、内部配置或凭据。

涉及 genapi 时还应确认 `dist/runtime-enum.js`、对应 `.d.ts` 和两个 CLI 都在包中，并让独立临时消费者从打包结果执行一次 `xapiforge-fetch`、`xapiforge <project>`、`--check` 和 TypeScript 编译。仓库的 `packages/genapi/test/independent-cli.test.js` 是最低自动回归，不替代真实 tarball 清单检查。

### 关于 source map、注释和“混淆”

xapiforge 是开源库，npm 包中的 JavaScript 不做混淆。混淆无法阻止源码被阅读，反而会让报错堆栈和问题定位变得困难。发布产物采用下面的约定：

- 不发布 source map 和 declaration map；
- 构建后移除 JavaScript 实现文件中的注释；
- 保留 `.d.ts` 中的 JSDoc，供编辑器显示参数和返回值说明；
- 不发布 `src/`、测试、开发配置和本地环境文件。

`pnpm publish:dry-run` 会逐个生成真实的 npm 压缩包并检查这些规则。不要只查看 `dist/` 后凭感觉判断发布内容。

### 4. 先在本地 registry 试装

涉及包入口、依赖、生成器或构建产物时，这一步必须做。先启动 Verdaccio 或现有本地 npm 服务，然后：

```bash
pnpm publish:local
```

在一次性目录里安装刚发布的精确版本：

```bash
mkdir /tmp/xapiforge-consumer
cd /tmp/xapiforge-consumer
pnpm init
pnpm add @xapiforge/core@0.1.5 @xapiforge/adapter-browser@0.1.5 --registry http://localhost:4873
pnpm add -D @xapiforge/genapi@0.1.5 --registry http://localhost:4873
```

把 `0.1.5` 换成这次版本。不要直接装 `latest`；pnpm 的 `minimumReleaseAge` 策略可能让新发布版本暂时不可选。

如果一次性项目启用了该策略，可只对本次验证版本加例外：

```yaml
minimumReleaseAgeExclude:
  - "@xapiforge/core@0.1.5"
  - "@xapiforge/adapter-browser@0.1.5"
  - "@xapiforge/genapi@0.1.5"
```

如果例外添加前已经生成了临时锁文件，在这个一次性目录中删除 `pnpm-lock.yaml` 后重新安装。不要把临时例外复制到业务仓库。

### 5. 提交版本改动

确认 diff 只包含本次发版内容，再提交并等待 CI 通过：

```bash
git diff --check
git status --short
git add package.json packages/*/package.json CHANGELOG.md pnpm-lock.yaml
git commit -m "release: 0.1.5"
git push origin main
```

如果 `pnpm-lock.yaml` 没有变化，不需要强行添加。

### 6. 确认 npm 登录状态

`pnpm publish:npm` 会先向公共 npm registry 检查登录状态，不受本机安装依赖时使用的镜像配置影响。如果检查失败，再登录公共 npm：

```bash
npm login --registry https://registry.npmjs.org/
```

npm 目前要求发布账号启用 2FA，或使用允许发布的受限凭据。账号采用安全密钥 / Passkey 时，直接运行发布命令并按浏览器提示确认；它不会提供一个需要手工填写的六位数字。恢复码只用于账号恢复，不要填进 `--otp`，也不要记录在仓库中。

`--otp` 只适用于认证器应用生成的数字动态码。通常让 npm CLI 交互提示更不容易混淆。

### 7. 正式发布

再次确认目标是公共 npm，然后执行：

```bash
pnpm publish:npm
```

这是正常发布唯一需要记住的命令。脚本会按以下顺序自动完成：

1. 使用 `https://registry.npmjs.org/` 检查 npm 登录状态；
2. 运行 `pnpm verify`；
3. 逐包发布；
4. 从公共 npm 逐包确认精确版本和 dist-tag。

稳定版本默认使用 `latest`；`0.2.0-alpha.0` 之类的预发布版本默认使用 `alpha`。看到 npm 的安全密钥或浏览器确认提示时，按当前账号的 2FA 方式完成验证。

发布预发布版本后，普通的 `npm install @xapiforge/core` 仍解析 `latest`；只有显式安装 `@xapiforge/core@alpha` 或精确预发布版本的使用者会获得 alpha。

### 8. 验证线上包

`pnpm publish:npm` 已自动逐包确认精确版本和 dist-tag；任一结果不符合预期都会以非零状态退出。日志中的 `verified: <包名>@<版本> (<tag>)` 表示该包的线上结果已确认。

再在新的临时项目中从公共 npm 安装 core、一个 adapter 和 genapi，执行一次生成和 TypeScript 构建。这样才能发现 registry 包内容与 monorepo 源码运行方式不同的问题。

### 9. 打 Git tag

六个包和临时试装都确认后再打 tag：

```bash
git tag v0.1.5
git push origin v0.1.5
```

## 发布中途失败

npm 的同名同版本不能重复发布。先用 `npm view <包名>@<版本> version` 查清哪些包已经成功，不要直接修改版本号重来。

如果前几个包已经发布，可以从第一个未发布的包继续：

```bash
pnpm publish:check
pnpm exec tsx scripts/publish-packages.ts \
  --target npm \
  --confirm \
  --from @xapiforge/adapter-browser
```

`--from` 指定的包也会发布。使用前必须确认它和后面的包在 npm 上都还没有该版本。

如果错误发生在包内容或依赖本身，不能覆盖已经发布的版本。修复代码、增加 patch 版本并在 CHANGELOG 说明，再走一遍完整流程。

## 后续可选：Trusted Publishing

npm 支持用 GitHub Actions OIDC 发布，避免保存长期 npm token，并可生成 provenance。配置它会改变公开发布权限和远程 workflow，必须单独评审和授权；当前仓库仍以人工发布为准。

参考 npm 官方文档：[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)。

## 安全底线

- 不提交带真实 token 的 `.npmrc`；仓库中的 `.npmrc.example` 只提供字段示例。
- 不在命令、截图、issue 或日志中记录密码、恢复码、安全密钥信息和 npm token。
- 不从脏工作区发公共版本。
- 不使用 `--force` 覆盖 tag，也不尝试复用已经发布过的 npm 版本号。
