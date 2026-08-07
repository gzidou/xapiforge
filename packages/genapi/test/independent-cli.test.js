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
  assert.equal(packageJson.dependencies.typescript, "^5.9.3");
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
      `import { defineConfig } from "@xapiforge/genapi";
      export default defineConfig({
        defaultPath: "/swagger/v1/swagger.json",
        timeoutMs: 15000,
        outputDir: "swagger",
        mode: "offline",
        projects: [{
          name: "demo",
          displayName: "Independent Consumer",
          baseHost: "http://localhost:8787",
          services: [{ name: "base", displayName: "Base API", port: 8787 }]
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
                        properties: { ok: { type: "boolean" } },
                      },
                    },
                  },
                },
              },
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
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
});
