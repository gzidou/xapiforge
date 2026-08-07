import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { generate, generateMany, validateConfig } from "../dist/index.js";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const tscPath = join(packageDir, "node_modules", "typescript", "bin", "tsc");

function service(name, extra = {}) {
  return {
    name,
    displayName: `${name} service`,
    port: 8787,
    ...extra,
  };
}

function config(services, projectExtra = {}, rootExtra = {}) {
  return {
    defaultPath: "/swagger/v1/swagger.json",
    timeoutMs: 15_000,
    outputDir: "swagger",
    mode: "offline",
    projects: [
      {
        name: "demo",
        displayName: "Demo",
        baseHost: "http://localhost",
        services,
        ...projectExtra,
      },
    ],
    ...rootExtra,
  };
}

function document({ paths = {}, schemas = {} } = {}) {
  return {
    openapi: "3.0.3",
    info: { title: "Fixture", version: "1.0.0" },
    paths,
    components: { schemas },
  };
}

async function writeSwagger(root, serviceName, value) {
  const directory = join(root, "swagger", "demo");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${serviceName}.json`), JSON.stringify(value), "utf8");
}

async function withTempProject(run) {
  const root = await mkdtemp(join(tmpdir(), "xapiforge-genapi-v2-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    await run(root);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("validateConfig rejects unsafe IDs, generated-name collisions, and invalid namespaces", () => {
  assert.throws(
    () => validateConfig(config([service("Base")])),
    /projects\[0\]\.services\[0\]\.name 必须匹配/,
  );
  assert.throws(
    () => validateConfig(config([service("a-1"), service("a1")])),
    /生成相同 TypeScript 名称 "A1"/,
  );
  assert.throws(
    () =>
      validateConfig(
        config(
          [service("base")],
          {},
          {
            namespacePrefixAliases: [{ match: "Fixture.", namespace: "default" }],
          },
        ),
      ),
    /必须是非保留的 TypeScript 标识符/,
  );
});

test("generation reuses one normalized document for types, aliases, and endpoint metadata", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "base",
      document({
        paths: {
          "/removed": {
            get: { responses: { 200: { description: "OK" } } },
          },
        },
        schemas: { OldDto: { type: "object", properties: { old: { type: "string" } } } },
      }),
    );

    let transformSwaggerCalls = 0;
    let transformTypesCalls = 0;
    const projectHooks = {
      async transformSwagger(swagger) {
        transformSwaggerCalls += 1;
        delete swagger.paths["/removed"];
        swagger.paths["/kept"] = {
          post: { responses: { 204: { description: "Updated" } } },
        };
        swagger.components.schemas = {
          NewDto: { type: "object", properties: { value: { type: "number" } } },
        };
        return swagger;
      },
      async transformTypes(content, context) {
        transformTypesCalls += 1;
        assert.ok(context.originalDocument.components.schemas.OldDto);
        assert.ok(context.normalizedDocument.components.schemas.NewDto);
        return `${content}\n// transformed once\n`;
      },
    };
    let rootHookCalls = 0;
    const rootHooks = {
      async transformSwagger(swagger) {
        rootHookCalls += 1;
        return swagger;
      },
    };

    const result = await generate({
      xapiForgeConfig: config([service("base")], { hooks: projectHooks }),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
      hooks: rootHooks,
    });

    assert.equal(transformSwaggerCalls, 1);
    assert.equal(transformTypesCalls, 1);
    assert.equal(rootHookCalls, 0);
    assert.equal(result.totalEndpoints, 1);

    const generatedTypes = await readFile(join(root, "generated/demo/types/base.ts"), "utf8");
    const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    const generatedIndex = await readFile(join(root, "generated/demo/index.ts"), "utf8");
    assert.match(generatedTypes, /"\/kept"/);
    assert.doesNotMatch(generatedTypes, /"\/removed"/);
    assert.match(generatedTypes, /NewDto/);
    assert.match(generatedTypes, /transformed once/);
    assert.match(apiTypes, /NewDto/);
    assert.doesNotMatch(apiTypes, /OldDto/);
    assert.match(generatedIndex, /总 endpoint 数：1/);
  });
});

test("service hooks use whole-object precedence and an explicit empty object disables inheritance", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(root, "inherited", document());
    await writeSwagger(root, "disabled", document());
    let projectHookCalls = 0;
    let rootHookCalls = 0;
    const cfg = config([service("inherited"), service("disabled", { hooks: {} })], {
      hooks: {
        async transformSwagger(swagger) {
          projectHookCalls += 1;
          return swagger;
        },
      },
    });

    await generate({
      xapiForgeConfig: cfg,
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
      hooks: {
        async transformSwagger(swagger) {
          rootHookCalls += 1;
          return swagger;
        },
      },
    });

    assert.equal(projectHookCalls, 1);
    assert.equal(rootHookCalls, 0);
  });
});

test("all required Swagger is loaded before the generator writes new files", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(root, "base", document());
    const outputDirectory = join(root, "generated", "demo");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, "existing.txt"), "old", "utf8");

    await assert.rejects(
      generate({
        xapiForgeConfig: config([service("base"), service("missing")]),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      /required Swagger 缺失/,
    );

    assert.equal(await readFile(join(outputDirectory, "existing.txt"), "utf8"), "old");
    assert.equal(existsSync(join(outputDirectory, "types")), false);
  });
});

test("endpoint metadata ignores path-level parameters", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "base",
      document({
        paths: {
          "/items": {
            parameters: [{ in: "header", name: "x-request-id", schema: { type: "string" } }],
            get: { responses: { 200: { description: "OK" } } },
          },
        },
      }),
    );
    const result = await generate({
      xapiForgeConfig: config([service("base")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    assert.equal(result.totalEndpoints, 1);
  });
});

test("external references fail before writing generated output", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "base",
      document({ schemas: { RemoteDto: { $ref: "https://example.invalid/schema.json" } } }),
    );
    await assert.rejects(
      generate({
        xapiForgeConfig: config([service("base")]),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      /暂不支持外部 \$ref/,
    );
    assert.equal(existsSync(join(root, "generated")), false);
  });
});

test("layered client config applies defined service overrides and preserves flat config", async () => {
  await withTempProject(async (root) => {
    const pingDocument = document({
      paths: {
        "/ping": {
          get: { responses: { 200: { description: "OK" } } },
        },
      },
    });
    await writeSwagger(root, "base", pingDocument);
    await writeSwagger(root, "infrastructure", pingDocument);
    await generate({
      xapiForgeConfig: config([service("base"), service("infrastructure")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });

    const generatedIndexPath = join(root, "generated/demo/index.ts");
    const generatedIndex = await readFile(generatedIndexPath, "utf8");
    assert.match(generatedIndex, /import type \{ NetClient, NetConfig, ValidateStatus \}/);
    assert.match(generatedIndex, /"retryDelayMs"/);
    assert.match(generatedIndex, /"logger"/);
    assert.match(generatedIndex, /override\.middleware === undefined/);

    await writeFile(
      join(root, "layered-usage.ts"),
      `import { createDemoClient } from "./generated/demo/index.js";
import type { ApiDemo } from "./generated/demo/index.js";
import type { NetConfig } from "@xapiforge/core";
declare const authService: NetConfig["authService"];
const layered: ApiDemo<true> = createDemoClient({
  defaults: {
    baseURL: "https://gateway.example.test",
    authService,
    validateStatus: (response) => response.status < 500,
  },
  services: {
    infrastructure: { baseURL: "https://infrastructure.example.test", middleware: [] },
  },
});
const flat: ApiDemo<false> = createDemoClient({
  baseURL: "https://legacy.example.test",
  authService,
});
void layered;
void flat;
`,
      "utf8",
    );
    await writeFile(
      join(root, "layered-tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          baseUrl: root,
          paths: {
            "@xapiforge/core": [join(packageDir, "../core/src/index.ts")],
          },
        },
        include: ["layered-usage.ts"],
      }),
      "utf8",
    );
    const typed = spawnSync(
      process.execPath,
      [tscPath, "-p", join(root, "layered-tsconfig.json")],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(typed.status, 0, `${typed.stdout}\n${typed.stderr}`);

    const bundlePath = join(root, "generated-client.mjs");
    await build({
      entryPoints: [generatedIndexPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      outfile: bundlePath,
      logLevel: "silent",
      alias: {
        "@xapiforge/core": join(packageDir, "../core/src/index.ts"),
      },
    });
    const { createDemoClient } = await import(
      `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
    );
    const requests = [];
    const defaultMiddleware = {
      onRequest({ request }) {
        request.headers.set("x-config-source", "defaults");
        return request;
      },
    };
    const infrastructureMiddleware = {
      onRequest({ request }) {
        request.headers.set("x-config-source", "infrastructure");
        return request;
      },
    };
    const fetch = async (request) => {
      requests.push({
        url: request.url,
        source: request.headers.get("x-config-source"),
      });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const authService = { getToken: async () => null };

    const layered = createDemoClient({
      defaults: {
        baseURL: "https://gateway.example.test",
        authService,
        middleware: [defaultMiddleware],
        fetch,
      },
      services: {
        infrastructure: {
          baseURL: "https://infrastructure.example.test",
          middleware: [infrastructureMiddleware],
          fetch: undefined,
        },
      },
    });
    await layered.base.GET("/ping");
    await layered.infrastructure.GET("/ping");

    const flat = createDemoClient({
      baseURL: "https://legacy.example.test",
      authService,
      fetch,
    });
    await flat.base.GET("/ping");

    assert.deepEqual(requests, [
      { url: "https://gateway.example.test/ping", source: "defaults" },
      { url: "https://infrastructure.example.test/ping", source: "infrastructure" },
      { url: "https://legacy.example.test/ping", source: null },
    ]);
  });
});

test("multi-service schemas stay isolated through SchemasByService and SchemaOf", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "identity",
      document({
        schemas: {
          "Shared.UserDto": {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      }),
    );
    await writeSwagger(
      root,
      "infrastructure",
      document({
        schemas: {
          "Shared.UserDto": {
            type: "object",
            required: ["id"],
            properties: { id: { type: "number" } },
          },
        },
      }),
    );
    const cfg = config([service("identity"), service("infrastructure")], {
      typeExports: {
        aliases: [
          { service: "identity", schema: "Shared.UserDto", exportAs: "IdentityUser" },
          {
            service: "infrastructure",
            schema: "Shared.UserDto",
            exportAs: "InfrastructureUser",
          },
        ],
      },
    });
    await generate({
      xapiForgeConfig: cfg,
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });

    const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(apiTypes, /export interface SchemasByService/);
    assert.match(apiTypes, /export type SchemaOf</);
    assert.match(apiTypes, /export type IdentityUser = SchemaOf<"identity", "Shared\.UserDto">/);
    assert.match(
      apiTypes,
      /export type InfrastructureUser = SchemaOf<"infrastructure", "Shared\.UserDto">/,
    );
    assert.doesNotMatch(apiTypes, /export type AllSchemas/);

    await writeFile(
      join(root, "usage.ts"),
      `import type { SchemaOf } from "./generated/demo/api-types.js";
const identity: SchemaOf<"identity", "Shared.UserDto"> = { id: "user-1" };
const infrastructure: SchemaOf<"infrastructure", "Shared.UserDto"> = { id: 1 };
void identity;
void infrastructure;
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
        include: ["usage.ts"],
      }),
      "utf8",
    );
    const compiled = spawnSync(process.execPath, [tscPath, "-p", join(root, "tsconfig.json")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  });
});

test("schema alias collisions fail with both identities and explicit aliases resolve them", async () => {
  await withTempProject(async (root) => {
    for (const serviceName of ["identity", "infrastructure"]) {
      await writeSwagger(
        root,
        serviceName,
        document({ schemas: { "Shared.UserDto": { type: "object" } } }),
      );
    }
    const services = [service("identity"), service("infrastructure")];
    await assert.rejects(
      generate({
        xapiForgeConfig: config(services),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      (error) => {
        assert.match(error.message, /schema alias 冲突：UserDto/);
        assert.match(error.message, /identity\/Shared\.UserDto/);
        assert.match(error.message, /infrastructure\/Shared\.UserDto/);
        assert.match(
          error.message,
          /\{ service: "infrastructure", schema: "Shared\.UserDto", exportAs: "InfrastructureUserDto" \}/,
        );
        return true;
      },
    );
    assert.equal(existsSync(join(root, "generated")), false);

    await assert.rejects(
      generate({
        xapiForgeConfig: config(services, {
          typeExports: {
            aliases: [{ service: "identity", schema: "MissingDto", exportAs: "IdentityMissing" }],
          },
        }),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      /显式 alias 指向不存在的 schema：identity\/MissingDto/,
    );
  });
});

test("legacy multi-service AllSchemas refuses duplicate full schema names", async () => {
  await withTempProject(async (root) => {
    for (const serviceName of ["identity", "infrastructure"]) {
      await writeSwagger(
        root,
        serviceName,
        document({ schemas: { "Shared.UserDto": { type: "object" } } }),
      );
    }
    await assert.rejects(
      generate({
        xapiForgeConfig: config([service("identity"), service("infrastructure")], {
          compatibility: { legacyAllSchemas: true },
          typeExports: {
            aliases: [
              { service: "identity", schema: "Shared.UserDto", exportAs: "IdentityUser" },
              {
                service: "infrastructure",
                schema: "Shared.UserDto",
                exportAs: "InfrastructureUser",
              },
            ],
          },
        }),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      /legacyAllSchemas 无法安全生成/,
    );
  });
});

test("deterministic generation emits a manifest and check mode is read-only", async () => {
  await withTempProject(async (root) => {
    const swagger = document({
      paths: { "/items": { get: { responses: { 200: { description: "OK" } } } } },
      schemas: { ItemDto: { type: "object", properties: { id: { type: "string" } } } },
    });
    await writeSwagger(root, "base", swagger);
    const options = {
      xapiForgeConfig: config([service("base")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    };

    const first = await generate(options);
    assert.equal(first.changed, true);
    assert.equal(first.filesWritten, 4);
    const indexPath = join(root, "generated/demo/index.ts");
    const firstIndex = await readFile(indexPath, "utf8");
    assert.doesNotMatch(firstIndex, /生成时间/);

    const manifest = JSON.parse(await readFile(join(root, "generated/demo/manifest.json"), "utf8"));
    assert.deepEqual(
      {
        formatVersion: manifest.formatVersion,
        generator: manifest.generator,
        openapiTypescriptVersion: manifest.openapiTypescriptVersion,
        typescriptVersion: manifest.typescriptVersion,
        esbuildVersion: manifest.esbuildVersion,
      },
      {
        formatVersion: 2,
        generator: "@xapiforge/genapi",
        openapiTypescriptVersion: "7.13.0",
        typescriptVersion: "5.9.3",
        esbuildVersion: "0.28.1",
      },
    );

    const second = await generate(options);
    assert.equal(second.changed, false);
    assert.deepEqual(second.changedFiles, []);
    assert.equal(await readFile(indexPath, "utf8"), firstIndex);

    swagger.paths["/changed"] = { post: { responses: { 204: { description: "Changed" } } } };
    await writeSwagger(root, "base", swagger);
    const checked = await generate({ ...options, check: true });
    assert.equal(checked.changed, true);
    assert.ok(checked.changedFiles.includes("types/base.ts"));
    assert.ok(checked.changedFiles.includes("manifest.json"));
    assert.equal(await readFile(indexPath, "utf8"), firstIndex);
  });
});

test("generateMany prepares every project before writing any output", async () => {
  await withTempProject(async (root) => {
    for (const projectName of ["first", "second"]) {
      const directory = join(root, "swagger", projectName);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "base.json"), JSON.stringify(document()), "utf8");
    }
    const cfg = {
      defaultPath: "/swagger/v1/swagger.json",
      timeoutMs: 15_000,
      outputDir: "swagger",
      mode: "offline",
      projects: [
        {
          name: "first",
          displayName: "First",
          baseHost: "http://localhost",
          services: [service("base")],
        },
        {
          name: "second",
          displayName: "Second",
          baseHost: "http://localhost",
          services: [service("base")],
          hooks: {
            async transformSwagger() {
              throw new Error("second project failed");
            },
          },
        },
      ],
    };

    await assert.rejects(
      generateMany(
        cfg.projects.map((project) => ({
          xapiForgeConfig: cfg,
          projectId: project.name,
          swaggerDir: "swagger",
          outputDir: "generated",
        })),
      ),
      /second project failed/,
    );
    assert.equal(existsSync(join(root, "generated")), false);
  });
});

test("transactional replacement removes stale service files and leaves no transaction artifacts", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(root, "base", document());
    await writeSwagger(root, "obsolete", document());
    const common = {
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    };
    await generate({
      ...common,
      xapiForgeConfig: config([service("base"), service("obsolete")]),
    });
    assert.equal(existsSync(join(root, "generated/demo/types/obsolete.ts")), true);

    const updated = await generate({
      ...common,
      xapiForgeConfig: config([service("base")]),
    });
    assert.equal(updated.changed, true);
    assert.ok(updated.changedFiles.includes("types/obsolete.ts"));
    assert.equal(existsSync(join(root, "generated/demo/types/obsolete.ts")), false);

    const rootEntries = await readdir(join(root, "generated"));
    assert.deepEqual(rootEntries, ["demo"]);
  });
});

test("an interrupted committing transaction restores its backup before the next generation", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(root, "base", document());
    const options = {
      xapiForgeConfig: config([service("base")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    };
    await generate(options);

    const outputRoot = join(root, "generated");
    const outputDir = join(outputRoot, "demo");
    const transactionId = "interrupted-test";
    const stagingName = `.demo.xapiforge-tmp-${transactionId}`;
    const backupName = `.demo.xapiforge-backup-${transactionId}`;
    const stateName = `.xapiforge-transaction-${transactionId}.json`;
    await rename(outputDir, join(outputRoot, backupName));
    await mkdir(join(outputRoot, stagingName), { recursive: true });
    await writeFile(join(outputRoot, stagingName, "partial.txt"), "partial", "utf8");
    await writeFile(
      join(outputRoot, stateName),
      JSON.stringify({
        formatVersion: 1,
        transactionId,
        phase: "committing",
        projects: [
          {
            project: "demo",
            output: "demo",
            staging: stagingName,
            backup: backupName,
            hadOutput: true,
          },
        ],
      }),
      "utf8",
    );

    const recovered = await generate(options);
    assert.equal(recovered.changed, false);
    assert.equal(existsSync(join(outputDir, "manifest.json")), true);
    assert.equal(existsSync(join(outputDir, "partial.txt")), false);
    assert.deepEqual(await readdir(outputRoot), ["demo"]);
  });
});
