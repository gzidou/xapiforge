# 文档站部署手册

本文记录 `xapiforge` 文档站如何发布到 GitHub Pages，以及 2026-08-06 首次部署时遇到的问题和排查结论。

文档地址：

```text
https://gzidou.github.io/xapiforge/
```

## 当前发布方式

文档源文件在 `docs/`，使用 VitePress 构建。

GitHub Pages 当前使用分支发布：

```text
Source: Deploy from a branch
Branch: gh-pages
Folder: / (root)
```

也就是说：

1. 在 `main` 分支维护文档源文件。
2. 运行 `pnpm docs:build` 生成 `docs/.vitepress/dist`。
3. 把 `docs/.vitepress/dist` 的静态文件发布到 `gh-pages` 分支根目录。
4. GitHub Pages 从 `gh-pages /` 对外服务。

## 本地验证

改文档后先在本地构建：

```bash
pnpm docs:build
```

构建成功后会生成：

```text
docs/.vitepress/dist/
```

VitePress 可能提示 chunk 较大，例如：

```text
Some chunks are larger than 500 kB after minification
```

这只是体积提示，不代表构建失败。

## 自动发布

仓库有 Docs workflow：

```text
.github/workflows/docs.yml
```

它会在推送 `main` 时：

1. 安装依赖。
2. 执行 `pnpm docs:build`。
3. 把构建产物提交并推送到 `gh-pages` 分支。

如果需要手动触发，可在 GitHub 页面：

```text
Actions -> Docs -> Run workflow
```

## 手动发布

正常情况下不需要手动发布。只有自动 workflow 不可用时，才使用下面的方式。

先构建文档：

```bash
pnpm docs:build
```

创建临时 worktree：

```bash
mkdir -p /tmp/xapiforge-gh-pages
git worktree add --detach /tmp/xapiforge-gh-pages
cd /tmp/xapiforge-gh-pages
git switch --orphan gh-pages
```

清空临时 worktree 并复制产物：

```bash
find /tmp/xapiforge-gh-pages -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R /path/to/xapiforge/docs/.vitepress/dist/. /tmp/xapiforge-gh-pages/
touch /tmp/xapiforge-gh-pages/.nojekyll
```

提交并推送：

```bash
git add -A
git commit -m "docs: publish site"
git push origin HEAD:gh-pages
```

如果远端 `gh-pages` 已有新提交，不要直接 `--force`。先读取远端 SHA：

```bash
git ls-remote --heads origin gh-pages
```

再用 `--force-with-lease`，并把 `<REMOTE_SHA>` 替换成上一步查到的值：

```bash
git push --force-with-lease=gh-pages:<REMOTE_SHA> origin HEAD:gh-pages
```

## 发布后验证

先看 GitHub Pages 配置：

```bash
gh api repos/gzidou/xapiforge/pages --jq '{html_url,build_type,source,status}'
```

期望：

```json
{
  "html_url": "https://gzidou.github.io/xapiforge/",
  "build_type": "legacy",
  "source": {
    "branch": "gh-pages",
    "path": "/"
  },
  "status": "built"
}
```

再打开网页：

```text
https://gzidou.github.io/xapiforge/
```

如果看到 `GitHub Pages smoke test.`，说明线上还停留在临时测试页，不是正式文档。

## 首次部署问题记录

首次部署时遇到过两个现象：

1. `actions/deploy-pages` 模式一直显示：

```text
Current status: deployment_in_progress
Canceling Pages deployment...
Error: The operation was canceled.
```

2. 改成 `gh-pages` 分支后，GitHub Pages 页面短暂显示 `Page build failed.`。

最终查到关键日志是 GitHub Pages 自动 workflow 的 `build` job 失败在 GitHub 自身 action 下载阶段：

```text
Failed to resolve action download info. Error: Internal Server Error
Failed to resolve action download info. Error: Service Unavailable
Failed to resolve action download info.
```

结论：

- 不是 VitePress 构建失败。
- 不是文档产物文件太大。
- 不是 `.nojekyll` 缺失。
- 不是 `GITHUB_TOKEN` 写权限不足。
- 不是 `github-pages` environment 等待人工审批。
- 当时主要是 GitHub Pages / Actions 服务端发布链路不稳定。

这次排查中，用只有 `index.html + .nojekyll` 的最小页面做过验证。最小页面可以上线，证明仓库 Pages 访问链路是通的。正式文档恢复后，再次触发 Pages build，最终成功。

## 如果以后再次失败

按下面顺序查，不要一上来改代码：

1. 查 Pages 配置：

```bash
gh api repos/gzidou/xapiforge/pages --jq '{html_url,build_type,source,status}'
```

2. 查最新 Pages build：

```bash
gh api repos/gzidou/xapiforge/pages/builds/latest --jq '{status,error,updated_at,commit}'
```

3. 查 Pages 自动 workflow：

```bash
gh run list --repo gzidou/xapiforge --workflow pages-build-deployment --limit 5
```

4. 查失败日志：

```bash
gh run view <RUN_ID> --repo gzidou/xapiforge --log-failed
```

如果日志里是 `Internal Server Error`、`Service Unavailable`、`Failed to resolve action download info`，不要改文档源码，等 GitHub 恢复后重新触发 Pages build：

```bash
gh api --method POST repos/gzidou/xapiforge/pages/builds
```

## 仓库 About

仓库主页的 About 区域应维护：

```text
Website: https://gzidou.github.io/xapiforge/
Description: Framework-agnostic HTTP client and OpenAPI API generator
Topics: openapi, typescript, api-client, codegen, http-client
```

可用下面命令更新：

```bash
gh repo edit gzidou/xapiforge \
  --description "Framework-agnostic HTTP client and OpenAPI API generator" \
  --homepage "https://gzidou.github.io/xapiforge/" \
  --add-topic openapi \
  --add-topic typescript \
  --add-topic api-client \
  --add-topic codegen \
  --add-topic http-client
```
