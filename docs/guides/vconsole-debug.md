# vConsole 业务调试面板

`@xapiforge/vconsole-debug` 是一个框架无关的浏览器调试包，用于在 vConsole 中集中展示业务诊断信息、Storage 快照和项目自定义调试动作。

它不依赖 Vue、React、Vant 或路由库，也不直接依赖 `vconsole`。宿主项目自行安装并按需动态导入 vConsole，再把构造器和项目配置交给公共包。

## 职责边界

- vConsole 自带 `Storage` 面板：查看、编辑和删除任意 LocalStorage、SessionStorage、Cookie。
- 业务调试面板：解释业务字段、统一脱敏、复制诊断信息，以及执行带确认的业务动作。
- 宿主项目：决定 Token 如何清理、哪些缓存可以删除、哪些键属于敏感信息。

公共包不会猜测 Token 键，也不会默认清空任何 Storage。

## 普通 JavaScript / TypeScript 项目

```ts
import VConsole from "vconsole";
import { clearStorageExcept, createVConsoleDebugPlugin } from "@xapiforge/vconsole-debug";

const vConsole = new VConsole();
const debugPreferenceKey = "my-app.debug.vconsole";

vConsole.addPlugin(
  createVConsoleDebugPlugin(VConsole, {
    pluginName: "业务调试",
    sections: [
      {
        id: "runtime",
        title: "运行环境",
        items: [
          { label: "当前页面", getValue: () => location.href },
          { label: "在线状态", getValue: () => navigator.onLine }
        ]
      }
    ],
    storageAreas: [
      {
        id: "local",
        label: "localStorage",
        storage: localStorage,
        isSensitiveKey: key => /token|password|secret/i.test(key)
      },
      {
        id: "session",
        label: "sessionStorage",
        storage: sessionStorage,
        isSensitiveKey: key => /token|password|secret/i.test(key)
      }
    ],
    actions: [
      {
        id: "clear-storage",
        label: "清空浏览器存储",
        risk: "danger",
        confirmMessage: "清空本项目浏览器存储，是否继续？",
        run: () => {
          clearStorageExcept(localStorage, [debugPreferenceKey]);
          sessionStorage.clear();
        }
      }
    ]
  })
);
```

## 注册模型

### `sections`

用于显示环境、路由、认证状态等动态信息。每次打开面板或点击“刷新”都会重新调用 `getValue`。`sensitive: true` 的值在采集阶段就会替换为脱敏占位符，不进入 DOM，也不会进入复制内容。

### `storageAreas`

用于显示 Storage 中的键和值预览。通过 `isSensitiveKey` 对 Token、密码、ticket 等字段脱敏。长值会截断，完整编辑仍使用 vConsole 自带的 Storage 面板。

### `actions`

用于注册业务动作。公共包统一处理风险颜色、二次确认、执行状态、错误反馈和执行后的数据刷新。动作函数本身由宿主项目提供，因此可以接入任意认证服务或缓存模块。

## 安全建议

- 只在项目明确的 DEBUG 总开关开启时初始化 vConsole 和业务调试插件。
- 不要显示或复制完整 Token、密码、Cookie、ticket、密钥和连接字符串。
- 清空全部 Storage 时保留 vConsole 显示偏好，否则清理后可能失去调试入口。
- “只清 Token”和“清空全部 Storage”应是两个独立动作，并使用不同风险级别。
- 生产构建默认关闭 DEBUG；临时开启时也应控制使用范围。

## 非 Vue 项目

公共包只使用浏览器 DOM 和 vConsole 插件协议，不依赖框架生命周期。React、Ionic、原生 TypeScript 或其他 SPA 项目都可以在应用启动阶段按上述方式注册。SSR 项目必须放在浏览器端初始化代码中，不能在服务端执行。
