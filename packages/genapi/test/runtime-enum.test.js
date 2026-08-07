import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { createRuntimeEnumHooks, generate } from "../dist/index.js";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = join(packageDir, "../..");
const tscPath = join(packageDir, "node_modules", "typescript", "bin", "tsc");
const standardFixturePath = join(packageDir, "test/fixtures/standard-enums.json");
const legacyHookPath = join(repositoryRoot, "examples/demo-app/hooks/legacy-enum.ts");

function config(hooks) {
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

async function generateFixture(root, document, hooks) {
  const swaggerPath = join(root, "swagger/demo/base.json");
  await writeFile(swaggerPath, JSON.stringify(document), "utf8");
  await generate({
    xapiForgeConfig: config(hooks),
    projectId: "demo",
    swaggerDir: "swagger",
    outputDir: "generated",
  });
  return swaggerPath;
}

test("standard string/number enums emit opt-in runtime maps and flags remain number", async () => {
  await withTempProject(async (root) => {
    const fixture = JSON.parse(await readFile(standardFixturePath, "utf8"));
    const hooks = createRuntimeEnumHooks({
      metadata: { "Fixture.AccessMode": { isFlags: true } },
    });
    const swaggerPath = await generateFixture(root, fixture, hooks);
    const typesPath = join(root, "generated/demo/types/base.ts");
    const types = await readFile(typesPath, "utf8");

    assert.match(types, /"Fixture\.DeviceState": 0 \| 1/);
    assert.match(types, /"Fixture\.TaskStatus": "pending" \| "running"/);
    assert.match(types, /"Fixture\.AccessMode": number/);
    assert.match(types, /export const FixtureDeviceState = \{/);
    assert.match(types, /export const FixtureTaskStatusLabels/);
    assert.match(types, /Fixture\.AccessMode（Flags；API 字段保持 number/);

    const original = JSON.parse(await readFile(swaggerPath, "utf8"));
    assert.deepEqual(original.components.schemas["Fixture.AccessMode"].enum, [1, 2, 4]);

    await writeFile(
      join(root, "enum-usage.ts"),
      `import type { components } from "./generated/demo/types/base.js";
import { FixtureAccessMode, FixtureDeviceStateLabels } from "./generated/demo/types/base.js";
const state: components["schemas"]["Fixture.DeviceState"] = 1;
const combined: components["schemas"]["Fixture.AccessMode"] =
  FixtureAccessMode.Read | FixtureAccessMode.Execute;
const label: string = FixtureDeviceStateLabels[state];
void combined;
void label;
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
      entryPoints: [typesPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      outfile: bundlePath,
      logLevel: "silent",
    });
    const runtime = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
    assert.deepEqual(runtime.FixtureDeviceState, { Offline: 0, Online: 1 });
    assert.equal(runtime.FixtureDeviceStateLabels[1], "Online device");
    assert.equal(runtime.FixtureTaskStatus.Running, "running");
    assert.equal(runtime.FixtureAccessMode.Read | runtime.FixtureAccessMode.Execute, 5);
  });
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

    fixture.components.schemas["Fixture.DeviceState"]["x-enum-varnames"] = ["Offline"];
    await assert.rejects(
      generateFixture(root, fixture, createRuntimeEnumHooks()),
      /Fixture\.DeviceState.*x-enum-varnames 必须是长度为 2 的字符串数组/,
    );
    assert.equal(existsSync(join(root, "generated")), false);
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
