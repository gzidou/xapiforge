---
layout: home

hero:
  name: "@xapiforge/core"
  text: "Framework-agnostic HTTP client + API generator"
  tagline: 框架无关 · 多运行时 · 类型安全 · 鉴权内置
  actions:
    - theme: brand
      text: 快速接入
      link: /getting-started/browser
    - theme: alt
      text: 使用文档
      link: /guides/auth
    - theme: alt
      text: 维护文档
      link: /internals/architecture-v0.2

features:
  - title: 框架无关
    details: Vue / React / React Native / Ionic 共用同一份 @xapiforge/core。核心库零框架依赖，按运行时选 adapter。
  - title: 类型安全
    details: swagger.json → TypeScript API 客户端自动生成。openapi-fetch 提供端到端类型推导，路径/参数/响应全类型校验。
  - title: 鉴权内置
    details: AuthService 单飞 refresh + 窗口保护 + 超时。401 自动刷新 token 并重试，业务代码无感。
  - title: 多运行时
    details: fetch 可注入。浏览器用原生 fetch，Capacitor 用 capacitorFetch 走原生 HTTP（解决 webview CORS / 证书 / 性能问题）。
  - title: middleware 链
    details: 内置 auth / retry / httpError 三个内核 middleware。业务侧可加自定义 middleware（如 ABP envelope 解包）。
  - title: 文件下载
    details: api.download 走内核 middleware（鉴权 / 重试 / 进度）。Capacitor 环境提供 downloadFileNative 原生直写磁盘（0 内存）。
---
