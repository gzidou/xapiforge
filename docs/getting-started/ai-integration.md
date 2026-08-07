# 使用 AI 接入 xapiforge

仓库提供 `xapiforge-integration` Skill，供使用 Codex 或其他支持 `SKILL.md` 的 AI 编程工具接入项目。它会要求 AI 先检查接入项目，再选择 adapter、生成客户端并完成验证，不会把示例端口、OAuth 字段或业务协议直接复制到项目中。

Skill 源文件位于：

```text
.agents/skills/xapiforge-integration/
```

## 安装到 Codex

克隆 xapiforge 仓库后执行：

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R .agents/skills/xapiforge-integration "${CODEX_HOME:-$HOME/.codex}/skills/"
```

重新开始一个 Codex 任务，让 Codex 重新发现 Skill。其他 AI 编程工具如果支持 Skills，按该工具规定的 Skill 目录安装同一文件夹；不要只复制 `SKILL.md`，项目检查脚本和 references 也是 Skill 的一部分。

## 调用方式

在接入项目目录中明确调用：

```text
使用 $xapiforge-integration 检查当前项目，选择正确的 adapter，
接入现有 OpenAPI，并完成类型检查、生产构建和一个真实或 mock 请求验证。
```

也可以给出已有约束：

```text
使用 $xapiforge-integration 接入这个 Capacitor 项目。
沿用现有 pnpm、AuthService 和离线 swagger，不要改登录协议。
```

Skill 会读取项目锁文件、依赖、配置、OpenAPI 文件和现有 API/Auth 代码。它不会读取不到后端协议时自行编造；缺少 OpenAPI 地址、base URL 或刷新协议时，会要求接入者提供。

## AI 应该交付什么

一次完成的接入至少应说明：

- 安装了哪些包，为什么选择该 adapter；
- `xapiforge.config.ts` 对应哪个真实项目和服务；
- 生成了哪些客户端文件；
- `AuthService` 和 TokenStore 接到了哪里；
- 哪些类型检查、测试和生产构建已经通过；
- 实际观察了哪个真实或 mock 请求；
- 哪些设备、凭据、CORS、证书或后端条件尚未验证。

只完成依赖安装或代码生成，不算接入完成。

## 更新 Skill

Skill 随 xapiforge 仓库维护。更新前先查看 Skill 目录的改动，再用新目录替换本地安装版本。Skill 的详细步骤应与当前发布版本匹配；接入旧版 npm 包时，让 AI 优先检查已安装包的实际导出，不要直接套用最新文档。
