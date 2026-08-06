import { createRequire } from "node:module";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

/**
 * VitePress 配置
 *
 * 文档结构：
 *   docs/
 *   ├── index.md              # 首面
 *   ├── getting-started/      # 接入文档（按运行时场景）
 *   ├── guides/               # 使用文档（按功能）
 *   └── internals/            # 维护文档（架构 / 行为合同 / 场景清单）
 */

// pnpm 严格模式下，mermaid 的传递依赖（@braintree/sanitize-url / cytoscape 等）
// 不在根 node_modules，但 vitepress-plugin-mermaid 强制把它们放进 optimizeDeps.include，
// 导致 esbuild 预构建时 resolve 不到，浏览器拿到原始 CJS 报 named export 错误。
// 这里从 mermaid 包路径去 resolve 这些传递依赖，用 Vite alias 显式指向 .pnpm 实际文件，
// 让 Vite 走运行时 CJS 转换而非 optimizeDeps 预构建。
const require = createRequire(import.meta.url);
const mermaidEntry = require.resolve("mermaid");
const resolveFromMermaid = (id: string) => require.resolve(id, { paths: [mermaidEntry] });

const mermaidDepsAlias = {
  "@braintree/sanitize-url": resolveFromMermaid("@braintree/sanitize-url"),
  cytoscape: resolveFromMermaid("cytoscape"),
  "cytoscape-cose-bilkent": resolveFromMermaid("cytoscape-cose-bilkent"),
};

export default withMermaid(
  defineConfig({
    title: "xapiforge",
    description: "Framework-agnostic HTTP client + API generator",
    base: "/xapiforge/",
    lang: "zh-CN",
    lastUpdated: true,
    cleanUrls: true,

    // 禁用 markdown 中的 HTML 解析，避免 <paths>、<string, ...> 等
    // 泛型语法被 Vue 编译器误认为 HTML 标签（"Element is missing end tag"）
    markdown: {
      html: false,
    },

    vite: {
      resolve: {
        alias: mermaidDepsAlias,
      },
    },

    themeConfig: {
      nav: [
        { text: "接入指南", link: "/getting-started/" },
        { text: "使用文档", link: "/guides/auth" },
        { text: "维护文档", link: "/internals/maintenance" },
      ],

      sidebar: {
        "/getting-started/": [
          {
            text: "接入指南",
            items: [
              { text: "选择接入方式", link: "/getting-started/" },
              { text: "浏览器应用接入", link: "/getting-started/browser" },
              { text: "Ionic / Capacitor 接入", link: "/getting-started/ionic-capacitor" },
              { text: "React Native 接入", link: "/getting-started/react-native" },
            ],
          },
        ],
        "/guides/": [
          {
            text: "使用文档",
            items: [
              { text: "鉴权（token / refresh / 401）", link: "/guides/auth" },
              { text: "自定义 middleware", link: "/guides/middleware" },
              { text: "文件下载", link: "/guides/file-download" },
              { text: "错误处理", link: "/guides/error-handling" },
              { text: "vConsole 业务调试面板", link: "/guides/vconsole-debug" },
              { text: "枚举类型生成方案", link: "/guides/enums" },
              { text: "genapi Hooks 设计", link: "/guides/genapi-hooks" },
            ],
          },
        ],
        "/internals/": [
          {
            text: "维护文档",
            items: [
              { text: "维护入口", link: "/internals/maintenance" },
              { text: "架构设计 (v0.2)", link: "/internals/architecture-v0.2" },
              { text: "三层架构 + fetch 注入", link: "/internals/layered-architecture" },
              { text: "行为合同表", link: "/internals/behavior-contract" },
              { text: "场景清单", link: "/internals/scenarios" },
              { text: "验证指南", link: "/internals/validation" },
              { text: "发布手册", link: "/internals/publishing" },
              { text: "文档站部署", link: "/internals/docs-deployment" },
              { text: "后端协议库", link: "/internals/backend-protocols" },
              { text: "Stream 设计储备", link: "/internals/stream-design" },
              { text: "ABP Swagger 已知坑", link: "/internals/swagger-pitfalls" },
            ],
          },
        ],
      },

      socialLinks: [{ icon: "github", link: "https://github.com/gzidou/xapiforge" }],

      editLink: {
        pattern: "https://github.com/gzidou/xapiforge/edit/main/docs/:path",
        text: "在 GitHub 上修改此页",
      },

      footer: {
        message: "MIT Licensed",
      },

      outline: {
        level: [2, 3],
        label: "本页目录",
      },

      docFooter: {
        prev: "上一页",
        next: "下一页",
      },

      lastUpdatedText: "最后更新",

      search: {
        provider: "local",
        options: {
          translations: {
            button: {
              buttonText: "搜索文档",
              buttonAriaLabel: "搜索文档",
            },
            modal: {
              noResultsText: "无法找到相关结果",
              resetButtonTitle: "清除查询条件",
              footer: {
                selectText: "选择",
                navigateText: "切换",
              },
            },
          },
        },
      },
    },
  }),
);
