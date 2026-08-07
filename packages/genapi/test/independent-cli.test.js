import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(packageDir, "dist", "cli.js");
const fetchCliPath = join(packageDir, "dist", "fetch-cli.js");

test("published package carries its compatible TypeScript runtime", async () => {
  const packageJson = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies.esbuild, "0.28.1");
  assert.equal(packageJson.dependencies["openapi-typescript"], "7.13.0");
  assert.equal(packageJson.dependencies.typescript, "5.9.3");
  assert.equal(packageJson.engines.node, ">=20.19");
});

test("CLI generates types without consumer-level dependency binaries", async () => {
  const consumerDir = await mkdtemp(join(tmpdir(), "xapiforge-genapi-consumer-"));
  try {
    await mkdir(join(consumerDir, "swagger", "demo"), { recursive: true });
    const installedPackageDir = join(consumerDir, "node_modules", "@xapiforge", "genapi");
    await mkdir(installedPackageDir, { recursive: true });
    await symlink(join(packageDir, "dist"), join(installedPackageDir, "dist"), "dir");
    await writeFile(
      join(installedPackageDir, "package.json"),
      JSON.stringify({
        name: "@xapiforge/genapi",
        type: "module",
        exports: { ".": "./dist/index.js" },
      }),
      "utf8",
    );
    await writeFile(
      join(consumerDir, "xapiforge.config.ts"),
      `import { createRuntimeEnumHooks, defineConfig } from "@xapiforge/genapi";
      export default defineConfig({
        timeoutMs: 15000,
        outputDir: "swagger",
        mode: "offline",
        projects: [{
          name: "demo",
          displayName: "Independent Consumer",
          services: [{
            name: "base",
            displayName: "Base API",
            source: { file: "swagger/demo/base.json" },
            hooks: createRuntimeEnumHooks()
          }]
        }]
      });`,
      "utf8",
    );
    await writeFile(
      join(consumerDir, "swagger", "demo", "base.json"),
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Independent Consumer", version: "1.0.0" },
        paths: {
          "/api/ping": {
            get: {
              responses: {
                200: {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["ok"],
                        properties: {
                          ok: { type: "boolean" },
                          state: { $ref: "#/components/schemas/RuntimeState" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            RuntimeState: {
              type: "integer",
              enum: [0, 1],
              "x-enum-varnames": ["Offline", "Online"],
              "x-enum-labels": ["Offline", "Online"],
            },
          },
        },
      }),
      "utf8",
    );

    const spawnOptions = {
      cwd: consumerDir,
      encoding: "utf8",
      // The old implementation spawned `npx openapi-typescript`. Restricting PATH
      // proves generation uses the package dependency directly instead of a
      // consumer-level node_modules/.bin entry.
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    };

    const help = spawnSync(process.execPath, [cliPath, "--help"], spawnOptions);
    assert.equal(help.status, 0, `${help.stdout}\n${help.stderr}`);
    assert.match(help.stdout, /Usage: xapiforge/);
    const missingProject = spawnSync(process.execPath, [cliPath], spawnOptions);
    assert.equal(missingProject.status, 2, `${missingProject.stdout}\n${missingProject.stderr}`);
    const unknownProject = spawnSync(process.execPath, [cliPath, "unknown"], spawnOptions);
    assert.equal(unknownProject.status, 2, `${unknownProject.stdout}\n${unknownProject.stderr}`);
    assert.match(unknownProject.stderr, /未找到项目: unknown/);

    const fetchResult = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(fetchResult.status, 0, `${fetchResult.stdout}\n${fetchResult.stderr}`);

    const result = spawnSync(process.execPath, [cliPath, "demo"], spawnOptions);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const generated = await readFile(
      join(consumerDir, "src", "api", "gen", "demo", "types", "base.ts"),
      "utf8",
    );
    assert.match(generated, /"\/api\/ping"/);
    assert.match(generated, /ok: boolean/);
    assert.match(generated, /export const RuntimeState = \{/);

    const stableCheck = spawnSync(
      process.execPath,
      [cliPath, "demo", "--", "--check"],
      spawnOptions,
    );
    assert.equal(stableCheck.status, 0, `${stableCheck.stdout}\n${stableCheck.stderr}`);
    assert.match(stableCheck.stdout, /UNCHANGED demo/);

    const swaggerPath = join(consumerDir, "swagger", "demo", "base.json");
    const changedSwagger = JSON.parse(await readFile(swaggerPath, "utf8"));
    changedSwagger.paths["/api/changed"] = {
      get: { responses: { 200: { description: "Changed" } } },
    };
    await writeFile(swaggerPath, JSON.stringify(changedSwagger), "utf8");
    const driftCheck = spawnSync(process.execPath, [cliPath, "demo", "--check"], spawnOptions);
    assert.equal(driftCheck.status, 1, `${driftCheck.stdout}\n${driftCheck.stderr}`);
    assert.match(driftCheck.stdout, /DRIFT demo/);
    assert.equal(
      await readFile(join(consumerDir, "src", "api", "gen", "demo", "types", "base.ts"), "utf8"),
      generated,
    );

    const invalidOption = spawnSync(process.execPath, [cliPath, "demo", "--chek"], spawnOptions);
    assert.equal(invalidOption.status, 1, `${invalidOption.stdout}\n${invalidOption.stderr}`);
    assert.match(invalidOption.stderr, /未知参数：--chek/);
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
});
