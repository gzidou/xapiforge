# Runtime integration paths

Use this reference only after inspecting the consumer project. Commands below use pnpm notation; translate them to the package manager already selected by the consumer lockfile.

## Browser

Install:

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser
pnpm add -D @xapiforge/genapi
```

Choose one store:

- `localStorageStore(key)` for persistence across browser restarts;
- `sessionStorageStore(key)` for tab-session persistence;
- `cookieStore(key)` only for JavaScript-readable cookies.

`cookieStore` cannot create HttpOnly cookies and does not add Secure or SameSite automatically. Let the backend own session cookies that require those properties.

Guide: <https://gzidou.github.io/xapiforge/getting-started/browser>

## Ionic / Capacitor

Install Preferences storage:

```bash
pnpm add @xapiforge/core @xapiforge/adapter-capacitor @capacitor/preferences
pnpm add -D @xapiforge/genapi
```

Use `preferencesStore(key)`. If the application requires Keychain/Keystore storage, install `@capacitor-community/secure-storage` and use `secureStorageStore(key)` instead.

Install `@capacitor/filesystem` only when using `downloadFileNative`, then run the consumer's Capacitor sync command. The adapter does not implement a `CapacitorHttp` fetch wrapper. Continue with WebView fetch or inject an application-owned `FetchLike` that returns a standard `Response`.

Guide: <https://gzidou.github.io/xapiforge/getting-started/ionic-capacitor>

## React Native / Expo

For new projects, install:

```bash
pnpm add @xapiforge/core @xapiforge/adapter-react-native react-native-keychain
pnpm add -D @xapiforge/genapi
```

Use separate `keychainStore({ service })` instances for access and refresh tokens. Reusing one service overwrites the first value. `encryptedStorageStore` exists for legacy consumers of archived `react-native-encrypted-storage`; do not select it for a new project.

The adapter does not provide native file downloading. Keep the consumer's existing Expo FileSystem, react-native-fs, or equivalent strategy.

Guide: <https://gzidou.github.io/xapiforge/getting-started/react-native>

## Shared generation contract

All runtimes use `@xapiforge/genapi`, `xapiforge.config.ts`, `xapiforge-fetch`, and `xapiforge`.

Expected offline input:

```text
<outputDir>/<project-name>/<service-name>.json
```

Expected generated output with the default `genOutputDir: "src/api/gen"`:

```text
src/api/gen/<project-name>/
├── index.ts
├── api-types.ts
└── types/
    └── <service-name>.ts
```

The generated `index.ts` exports a factory named from the configured project ID, such as `createMyappClient` for `myapp`.

Detailed guides:

- Authentication: <https://gzidou.github.io/xapiforge/guides/auth>
- Error handling: <https://gzidou.github.io/xapiforge/guides/error-handling>
- Middleware: <https://gzidou.github.io/xapiforge/guides/middleware>
- genapi hooks: <https://gzidou.github.io/xapiforge/guides/genapi-hooks>
- File download: <https://gzidou.github.io/xapiforge/guides/file-download>
