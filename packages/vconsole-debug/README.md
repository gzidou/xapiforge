# @xapiforge/vconsole-debug

Framework-agnostic vConsole business diagnostics with masked Storage snapshots and configurable debug actions.

## Install

The host application owns the `vconsole` dependency:

```bash
pnpm add @xapiforge/vconsole-debug vconsole
```

## Register the plugin

```typescript
import VConsole from "vconsole";
import { createVConsoleDebugPlugin } from "@xapiforge/vconsole-debug";

const vConsole = new VConsole();

vConsole.addPlugin(
  createVConsoleDebugPlugin(VConsole, {
    pluginName: "Diagnostics",
    sections: [
      {
        id: "runtime",
        title: "Runtime",
        items: [
          { label: "URL", getValue: () => location.href },
          { label: "Online", getValue: () => navigator.onLine }
        ]
      }
    ],
    storageAreas: [
      {
        id: "local",
        label: "localStorage",
        storage: localStorage,
        isSensitiveKey: key => /token|password|secret/i.test(key)
      }
    ]
  })
);
```

Initialize it only behind an explicit debug switch. Sensitive values are masked before rendering and copying.

See the [vConsole debug guide](https://gzidou.github.io/xapiforge/guides/vconsole-debug) for actions, storage cleanup, and security guidance.
