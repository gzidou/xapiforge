import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import ts from "typescript";

import { createRuntimeEnumHooks, generate } from "../dist/index.js";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = join(packageDir, "../..");
const tscPath = join(packageDir, "node_modules", "typescript", "bin", "tsc");
const standardFixturePath = join(packageDir, "test/fixtures/standard-enums.json");
const legacyHookPath = join(repositoryRoot, "examples/demo-app/hooks/legacy-enum.ts");

function config(hooks, projectExtra = {}) {
  return {
    timeoutMs: 15_000,
    outputDir: "swagger",
    mode: "offline",
    projects: [
      {
        name: "demo",
        displayName: "Enum fixture",
        services: [
          {
            name: "base",
            displayName: "Base",
            source: { file: "swagger/demo/base.json" },
            hooks,
          },
        ],
        ...projectExtra,
      },
    ],
  };
}

async function withTempProject(run) {
  const root = await mkdtemp(join(tmpdir(), "xapiforge-runtime-enum-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    await mkdir(join(root, "swagger/demo"), { recursive: true });
    await run(root);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function generateFixture(root, document, hooks, projectExtra = {}) {
  const swaggerPath = join(root, "swagger/demo/base.json");
  await writeFile(swaggerPath, JSON.stringify(document), "utf8");
  await generate({
    xapiForgeConfig: config(hooks, projectExtra),
    projectId: "demo",
    swaggerDir: "swagger",
    outputDir: "generated",
  });
  return swaggerPath;
}

test("runtime enum metadata generates options, overrides, extensions, serialization, and namespaces", async () => {
  await withTempProject(async (root) => {
    const fixture = JSON.parse(await readFile(standardFixturePath, "utf8"));
    const hooks = createRuntimeEnumHooks({
      metadata: {
        "Fixture.DeviceState": {
          overrideLabels: { 0: "Disconnected", 1: "Connected" },
          overrideVarnames: { 1: "Connected" },
          appendValues: [{ name: "Unknown", label: "Unknown device", value: 2 }],
          extensions: {
            colors: { 0: "#999", 1: "#0a0", 2: "#f90" },
            icon: { 0: "WifiOff", 1: "Wifi" },
            presentation: {
              0: { order: 2, tone: "muted" },
              1: { order: 1, tone: "positive" },
            },
          },
          serializeAs: "string",
        },
        "Fixture.AccessMode": { isFlags: true },
      },
    });
    const swaggerPath = await generateFixture(root, fixture, hooks, {
      typeExports: {
        namespaces: [{ service: "base", match: "Fixture.", namespace: "Domain" }],
      },
    });
    const typesPath = join(root, "generated/demo/types/base.ts");
    const types = await readFile(typesPath, "utf8");
    const apiTypesPath = join(root, "generated/demo/api-types.ts");
    const apiTypes = await readFile(apiTypesPath, "utf8");

    assert.match(types, /"Fixture\.DeviceState": 0 \| 1 \| 2/);
    assert.match(types, /"Fixture\.TaskStatus": "pending" \| "running"/);
    assert.match(types, /"Fixture\.AccessMode": number/);
    assert.match(types, /export const FixtureDeviceState = \{/);
    assert.match(types, /\["Connected"\]: 1/);
    assert.match(types, /export const FixtureDeviceStateOptions = \[/);
    assert.match(types, /label: "Disconnected"/);
    assert.match(types, /export const FixtureDeviceStateColors = \{/);
    assert.match(types, /export const FixtureDeviceStateIcon = \{/);
    assert.match(types, /export const FixtureDeviceStatePresentation = \{/);
    assert.match(types, /export const FixtureDeviceStateSerialize/);
    assert.match(types, /Fixture\.AccessMode（Flags；API 字段保持 number/);
    assert.match(apiTypes, /export namespace BaseSchemas/);
    assert.match(apiTypes, /export namespace Domain/);
    assert.match(
      apiTypes,
      /export const DeviceStateOptions = BaseRuntime\.FixtureDeviceStateOptions/,
    );
    assert.match(
      apiTypes,
      /export const DeviceStateColors = BaseRuntime\.FixtureDeviceStateColors/,
    );
    assert.match(apiTypes, /export const RuntimeEnumsByService/);

    const original = JSON.parse(await readFile(swaggerPath, "utf8"));
    assert.deepEqual(original.components.schemas["Fixture.DeviceState"].enum, [0, 1]);
    assert.deepEqual(original.components.schemas["Fixture.DeviceState"]["x-enum-labels"], [
      "Offline device",
      "Online device",
    ]);
    assert.deepEqual(original.components.schemas["Fixture.AccessMode"].enum, [1, 2, 4]);

    await writeFile(
      join(root, "enum-usage.ts"),
      `import { BaseSchemas, RuntimeEnumsByService } from "./generated/demo/api-types.js";
const state: BaseSchemas.Domain.DeviceState = BaseSchemas.Domain.DeviceState.Connected;
const option: BaseSchemas.Domain.DeviceStateOption = BaseSchemas.Domain.DeviceStateOptions[1];
const label: string = BaseSchemas.Domain.DeviceStateLabels[state];
const color: string = BaseSchemas.Domain.DeviceStateColors[state];
const icon: "Wifi" = BaseSchemas.Domain.DeviceStateIcon[BaseSchemas.Domain.DeviceState.Connected];
const missingIcon: null = BaseSchemas.Domain.DeviceStateIcon[BaseSchemas.Domain.DeviceState.Unknown];
const serialized: string = BaseSchemas.Domain.serializeDeviceState(state);
const combined: BaseSchemas.Domain.AccessMode =
  BaseSchemas.Domain.AccessMode.Read | BaseSchemas.Domain.AccessMode.Execute;
const canonicalOptions = RuntimeEnumsByService.base["Fixture.DeviceState"].options;
void option;
void combined;
void label;
void color;
void icon;
void missingIcon;
void serialized;
void canonicalOptions;
`,
      "utf8",
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
        },
        include: ["enum-usage.ts"],
      }),
      "utf8",
    );
    const compiled = spawnSync(process.execPath, [tscPath, "-p", join(root, "tsconfig.json")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);

    const bundlePath = join(root, "runtime-enums.mjs");
    await build({
      entryPoints: [apiTypesPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      outfile: bundlePath,
      logLevel: "silent",
    });
    const runtime = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
    assert.deepEqual(runtime.BaseSchemas.Domain.DeviceState, {
      Offline: 0,
      Connected: 1,
      Unknown: 2,
    });
    assert.deepEqual(runtime.BaseSchemas.Domain.DeviceStateOptions[1], {
      key: "Connected",
      value: 1,
      label: "Connected",
    });
    assert.equal(runtime.BaseSchemas.Domain.DeviceStateColors[2], "#f90");
    assert.equal(runtime.BaseSchemas.Domain.DeviceStateIcon[2], null);
    assert.deepEqual(runtime.BaseSchemas.Domain.DeviceStatePresentation[1], {
      order: 1,
      tone: "positive",
    });
    assert.equal(runtime.BaseSchemas.Domain.serializeDeviceState(1), "1");
    assert.equal(runtime.RuntimeEnumsByService.base["Fixture.DeviceState"].value.Connected, 1);
    assert.equal(
      runtime.BaseSchemas.Domain.AccessMode.Read | runtime.BaseSchemas.Domain.AccessMode.Execute,
      5,
    );
  });
});

test("runtime enum registries preserve __proto__ as an ordinary own key", async () => {
  await withTempProject(async (root) => {
    const schemaName = "__proto__";
    const fixture = {
      openapi: "3.0.3",
      info: { title: "Special key fixture", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          [schemaName]: {
            type: "integer",
            enum: [0],
            "x-enum-varnames": ["__proto__"],
            "x-enum-labels": ["__proto__"],
          },
        },
      },
    };
    await generateFixture(root, fixture, createRuntimeEnumHooks());
    const apiTypesPath = join(root, "generated/demo/api-types.ts");
    const apiTypes = await readFile(apiTypesPath, "utf8");
    assert.match(apiTypes, /export type ___proto__/);
    assert.match(apiTypes, /\["__proto__"\]: \{/);

    const bundlePath = join(root, "special-key-enum.mjs");
    await build({
      entryPoints: [apiTypesPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      outfile: bundlePath,
      logLevel: "silent",
    });
    const runtime = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
    const publicEnum = runtime.BaseSchemas.___proto__;
    assert.equal(Object.hasOwn(publicEnum, "__proto__"), true);
    assert.equal(publicEnum.__proto__, 0);
    assert.equal(Object.hasOwn(runtime.BaseSchemas.___proto__ByLabel, "__proto__"), true);
    assert.equal(runtime.BaseSchemas.___proto__ByLabel.__proto__, 0);
    assert.equal(Object.hasOwn(runtime.RuntimeEnumsByService.base, schemaName), true);
    assert.equal(runtime.RuntimeEnumsByService.base[schemaName].value.__proto__, 0);
  });
});

test("transformTypes consumes normalizedDocument without rereading swaggerPath", async () => {
  const fixture = JSON.parse(await readFile(standardFixturePath, "utf8"));
  const hooks = createRuntimeEnumHooks({
    metadata: {
      "Fixture.DeviceState": {
        overrideLabels: { 1: "Ready for page" },
        extensions: { color: { 1: "green" } },
      },
    },
  });
  const context = {
    projectId: "demo",
    serviceName: "base",
    swaggerPath: "/path/that/does/not/exist.json",
    typesPath: "/tmp/base.ts",
  };
  const normalized = await hooks.transformSwagger(fixture, context);
  context.normalizedDocument = normalized;
  const generated = await hooks.transformTypes("// base types\n", context);
  assert.match(generated, /FixtureDeviceStateOptions/);
  assert.match(generated, /Ready for page/);
  assert.match(generated, /FixtureDeviceStateColor/);
});

test("runtime enums follow flat-strict namespaces and canonical service identity", async () => {
  for (const strategy of ["flat-strict", "canonical-only"]) {
    await withTempProject(async (root) => {
      const fixture = JSON.parse(await readFile(standardFixturePath, "utf8"));
      const typeExports =
        strategy === "flat-strict"
          ? {
              strategy,
              namespaces: [{ service: "base", match: "Fixture.", namespace: "Domain" }],
            }
          : { strategy };
      await generateFixture(root, fixture, createRuntimeEnumHooks(), { typeExports });
      const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
      const usage =
        strategy === "flat-strict"
          ? `import { Domain } from "./generated/demo/api-types.js";
const value: Domain.DeviceState = Domain.DeviceState.Online;
const option: Domain.DeviceStateOption = Domain.DeviceStateOptions[1];
void value;
void option;
`
          : `import { RuntimeEnumsByService } from "./generated/demo/api-types.js";
const value = RuntimeEnumsByService.base["Fixture.DeviceState"].value.Online;
const option = RuntimeEnumsByService.base["Fixture.DeviceState"].options[1];
void value;
void option;
`;
      if (strategy === "flat-strict") {
        assert.match(apiTypes, /export namespace Domain/);
        assert.match(apiTypes, /export const DeviceStateOptions = BaseRuntime/);
      } else {
        assert.doesNotMatch(apiTypes, /export namespace BaseSchemas/);
        assert.match(apiTypes, /export const RuntimeEnumsByService/);
      }
      await writeFile(join(root, "enum-mode-usage.ts"), usage, "utf8");
      await writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            skipLibCheck: true,
          },
          include: ["enum-mode-usage.ts"],
        }),
        "utf8",
      );
      const compiled = spawnSync(process.execPath, [tscPath, "-p", join(root, "tsconfig.json")], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(compiled.status, 0, `${strategy}\n${compiled.stdout}\n${compiled.stderr}`);
    });
  }
});

test("runtime enum metadata and x-enum arrays fail fast with actionable diagnostics", async () => {
  await withTempProject(async (root) => {
    const fixture = JSON.parse(await readFile(standardFixturePath, "utf8"));
    await assert.rejects(
      generateFixture(
        root,
        fixture,
        createRuntimeEnumHooks({ metadata: { "Fixture.Missing": { isFlags: true } } }),
      ),
      /metadata 引用了不存在的 schema "Fixture\.Missing"/,
    );
    assert.equal(existsSync(join(root, "generated")), false);

    await assert.rejects(
      generateFixture(
        root,
        fixture,
        createRuntimeEnumHooks({ metadata: { toString: { isFlags: true } } }),
      ),
      /metadata 引用了不存在的 schema "toString"/,
    );
    assert.equal(existsSync(join(root, "generated")), false);

    const invalidMetadataCases = [
      {
        metadata: { "Fixture.DeviceState": { typoField: true } },
        error: /metadata\["Fixture\.DeviceState"\] 包含未知字段 typoField/,
      },
      {
        metadata: { "Fixture.DeviceState": { overrideLabels: { 99: "Missing" } } },
        error: /overrideLabels 引用了不存在的 enum value "99"/,
      },
      {
        metadata: {
          "Fixture.DeviceState": {
            appendValues: [{ name: "Duplicate", label: "Duplicate", value: 1 }],
          },
        },
        error: /appendValues\[0\]\.value 与已有 enum value 1 冲突/,
      },
      {
        metadata: {
          "Fixture.DeviceState": { extensions: { color: { 99: "red" } } },
        },
        error: /extensions\["color"\] 引用了不存在的 enum value "99"/,
      },
      {
        metadata: {
          "Fixture.DeviceState": { extensions: { labels: { 0: "collision" } } },
        },
        error: /生成导出 "FixtureDeviceStateLabels" 冲突/,
      },
      {
        metadata: { "Fixture.TaskStatus": { serializeAs: "string" } },
        error: /serializeAs="string" 只支持数字枚举/,
      },
    ];
    for (const invalid of invalidMetadataCases) {
      const cleanFixture = JSON.parse(await readFile(standardFixturePath, "utf8"));
      await assert.rejects(
        generateFixture(root, cleanFixture, createRuntimeEnumHooks({ metadata: invalid.metadata })),
        invalid.error,
      );
      assert.equal(existsSync(join(root, "generated")), false);
    }

    const namespaceCollision = JSON.parse(await readFile(standardFixturePath, "utf8"));
    namespaceCollision.components.schemas["Fixture.DeviceStateOptions"] = { type: "object" };
    await assert.rejects(
      generateFixture(root, namespaceCollision, createRuntimeEnumHooks()),
      /runtime enum\/schema 导出冲突：DeviceStateOptions/,
    );
    assert.equal(existsSync(join(root, "generated")), false);

    fixture.components.schemas["Fixture.DeviceState"]["x-enum-varnames"] = ["Offline"];
    await assert.rejects(
      generateFixture(root, fixture, createRuntimeEnumHooks()),
      /Fixture\.DeviceState.*x-enum-varnames 必须是长度为 2 的字符串数组/,
    );
    assert.equal(existsSync(join(root, "generated")), false);
  });
});

test("runtime enum schema names cannot terminate generated comments", async () => {
  await withTempProject(async (root) => {
    const attack = "Evil */\nexport type Injected = never;\n/*";
    const fixture = {
      openapi: "3.0.3",
      info: { title: "Comment fixture", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          [attack]: {
            type: "string",
            enum: ["ready"],
            "x-enum-varnames": ["Ready"],
            "x-enum-descriptions": ["Ready"],
          },
        },
      },
    };
    await generateFixture(root, fixture, createRuntimeEnumHooks());
    const types = await readFile(join(root, "generated/demo/types/base.ts"), "utf8");
    const source = ts.createSourceFile("base.ts", types, ts.ScriptTarget.Latest, true);
    let injected = false;
    const visit = (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "Injected") injected = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(injected, false);
  });
});

test("copyable legacy enum hook normalizes values conservatively and supports flags", async () => {
  await withTempProject(async (root) => {
    const hookBundlePath = join(root, "legacy-hook.mjs");
    await build({
      entryPoints: [legacyHookPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      outfile: hookBundlePath,
      logLevel: "silent",
      alias: {
        "@xapiforge/genapi": join(packageDir, "dist/runtime-enum.js"),
      },
    });
    const { legacyEnumHooks, normalizeLegacyIntegerEnums } = await import(
      `${pathToFileURL(hookBundlePath).href}?test=${Date.now()}`
    );
    const legacy = {
      openapi: "3.0.3",
      info: { title: "Legacy fixture", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          "Fixture.LegacyState": {
            type: "integer",
            enum: ["Offline(Offline device)=0", "Online(Online device)=1"],
          },
          "Fixture.LegacyPermissions": {
            type: "integer",
            enum: ["Read(Read access)=1", "Write(Write access)=2", "Execute(Execute access)=4"],
          },
          "Fixture.UnknownLegacy": {
            type: "integer",
            enum: ["unrecognized", "StillUnknown=not-a-number"],
          },
        },
      },
    };
    const normalized = normalizeLegacyIntegerEnums(legacy);
    assert.deepEqual(normalized.components.schemas["Fixture.LegacyState"].enum, [0, 1]);
    assert.deepEqual(normalized.components.schemas["Fixture.UnknownLegacy"].enum, [
      "unrecognized",
      "StillUnknown=not-a-number",
    ]);

    await generateFixture(root, legacy, legacyEnumHooks);
    const types = await readFile(join(root, "generated/demo/types/base.ts"), "utf8");
    assert.match(types, /"Fixture\.LegacyState": 0 \| 1/);
    assert.match(types, /"Fixture\.LegacyPermissions": number/);
    assert.match(types, /export const FixtureLegacyState = \{/);
    assert.doesNotMatch(types, /export const FixtureUnknownLegacy/);
  });
});
