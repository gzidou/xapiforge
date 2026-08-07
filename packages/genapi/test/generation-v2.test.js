import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import {
  downloadJson,
  fetchSwaggerJson,
  generate,
  generateMany,
  validateConfig,
} from "../dist/index.js";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const tscPath = join(packageDir, "node_modules", "typescript", "bin", "tsc");

function service(name, extra = {}) {
  return {
    name,
    displayName: `${name} service`,
    source: { file: `swagger/demo/${name}.json` },
    ...extra,
  };
}

function config(services, projectExtra = {}, rootExtra = {}) {
  return {
    timeoutMs: 15_000,
    outputDir: "swagger",
    mode: "offline",
    projects: [
      {
        name: "demo",
        displayName: "Demo",
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
    () =>
      validateConfig({
        timeoutMs: 15_000,
        outputDir: "swagger",
        projects: [],
      }),
    /projects 必须是非空数组/,
  );
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
        config([service("base")], {
          typeExports: {
            namespaces: [{ match: "Fixture.", namespace: "default" }],
          },
        }),
      ),
    /必须是非保留的 TypeScript 标识符/,
  );
  assert.throws(
    () => validateConfig({ ...config([service("base")]), defaultPath: "/swagger.json" }),
    /根配置 包含 v2 已移除字段：defaultPath/,
  );
  assert.throws(
    () => validateConfig({ ...config([service("base")]), timeotMs: 1 }),
    /根配置 包含未知字段：timeotMs/,
  );
  assert.throws(
    () =>
      validateConfig(
        config([
          service("base", {
            source: { file: "swagger.json", url: "https://example.test/openapi.json" },
          }),
        ]),
      ),
    /source 必须且只能配置 file 或 url 其中一个/,
  );
  assert.throws(
    () =>
      validateConfig(
        config([
          service("base", {
            source: { url: "https://user:secret@example.test/openapi.json" },
          }),
        ]),
      ),
    /source\.url 不得包含用户名或密码/,
  );
  assert.throws(
    () =>
      validateConfig(
        config([service("identity"), service("billing")], {
          typeExports: {
            strategy: "flat-strict",
            aliases: [
              { service: "identity", schema: "Identity.UserDto", exportAs: "User" },
              { service: "billing", schema: "Billing.UserDto", exportAs: "User" },
            ],
          },
        }),
      ),
    /导出目标 User 重复/,
  );
});

test("source.url is fetched as the exact configured URL", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response('{"openapi":"3.0.3"}', {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  try {
    const url = "https://schemas.example.test/custom/location/openapi.json?tenant=stable";
    const result = await fetchSwaggerJson({ source: { url }, timeoutMs: 1_000 });
    assert.equal(result.ok, true);
    assert.equal(result.url, url);
    assert.equal(result.text, '{"openapi":"3.0.3"}');
    assert.deepEqual(requested, [url]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download retries network/5xx failures but not deterministic response errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response("unavailable", { status: 503 })
        : new Response("{}", { headers: { "content-type": "application/json" } });
    };
    assert.equal((await downloadJson("https://example.test/openapi.json", 1_000)).status, 200);
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("missing", { status: 404 });
    };
    await assert.rejects(downloadJson("https://example.test/missing.json", 1_000), /HTTP 404/);
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}", { headers: { "content-type": "text/plain" } });
    };
    await assert.rejects(
      downloadJson("https://example.test/not-json.json", 1_000),
      /Content-Type 不是 JSON/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source.file decouples service ID from filename and source relocation is output-stable", async () => {
  await withTempProject(async (root) => {
    const openapi = document({
      schemas: {
        "Stable.ItemDto": {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    });
    await mkdir(join(root, "inputs"), { recursive: true });
    await writeFile(join(root, "inputs/backend-name.json"), JSON.stringify(openapi), "utf8");
    const options = {
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    };
    const fileConfig = config([
      service("stable-service", { source: { file: "inputs/backend-name.json" } }),
    ]);
    await generate({ ...options, xapiForgeConfig: fileConfig });
    const baseline = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(baseline, /export namespace StableServiceSchemas/);

    await rename(join(root, "inputs/backend-name.json"), join(root, "inputs/renamed-openapi.json"));
    const relocated = await generate({
      ...options,
      xapiForgeConfig: config([
        service("stable-service", { source: { file: "inputs/renamed-openapi.json" } }),
      ]),
    });
    assert.equal(relocated.changed, false);

    await mkdir(join(root, "swagger/demo"), { recursive: true });
    await writeFile(
      join(root, "swagger/demo/stable-service.json"),
      JSON.stringify(openapi),
      "utf8",
    );
    const remoteCache = await generate({
      ...options,
      xapiForgeConfig: config([
        service("stable-service", {
          // exactOptionalPropertyTypes 未必开启；显式 undefined 也必须走 URL 分支。
          source: { url: "https://schemas.example.test/stable-service.json", file: undefined },
        }),
      ]),
    });
    assert.equal(remoteCache.changed, false);
    assert.equal(await readFile(join(root, "generated/demo/api-types.ts"), "utf8"), baseline);
  });
});

test("service and JSON object order never participate in generated identity", async () => {
  await withTempProject(async (root) => {
    const alpha = document({
      paths: { "/alpha": { get: { responses: { 200: { description: "OK" } } } } },
      schemas: {
        AlphaDto: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } } },
      },
    });
    const beta = document({ schemas: { BetaDto: { type: "string" } } });
    await writeSwagger(root, "alpha", alpha);
    await writeSwagger(root, "beta", beta);
    const options = { projectId: "demo", swaggerDir: "swagger", outputDir: "generated" };
    await generate({
      ...options,
      xapiForgeConfig: config([service("beta"), service("alpha")]),
    });

    const reorderedAlpha = {
      components: {
        schemas: {
          AlphaDto: {
            properties: { a: { type: "number" }, z: { type: "string" } },
            type: "object",
          },
        },
      },
      paths: { "/alpha": { get: { responses: { 200: { description: "OK" } } } } },
      info: { version: "1.0.0", title: "Fixture" },
      openapi: "3.0.3",
    };
    await writeSwagger(root, "alpha", reorderedAlpha);
    const reordered = await generate({
      ...options,
      xapiForgeConfig: config([service("alpha"), service("beta")]),
    });
    assert.equal(reordered.changed, false);
    assert.deepEqual(reordered.changedFiles, []);
  });
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
        assert.equal(Object.isFrozen(context.originalDocument), true);
        assert.ok(context.normalizedDocument.components.schemas.NewDto);
        assert.equal(Object.isFrozen(context.normalizedDocument), true);
        assert.equal(Object.isFrozen(context.normalizedDocument.components.schemas.NewDto), true);
        assert.throws(() => {
          context.normalizedDocument.paths["/late-mutation"] = {};
        }, TypeError);
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
    assert.match(generatedIndex, /const service = api\.base/);
    assert.doesNotMatch(generatedIndex, /\/api\/identity/);
  });
});

test("canonicalization preserves special JSON keys and rejects non-JSON hook values", async () => {
  await withTempProject(async (root) => {
    const specialSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    );
    await writeSwagger(root, "base", document({ schemas: { SpecialDto: specialSchema } }));
    await generate({
      xapiForgeConfig: config([service("base")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    const generated = await readFile(join(root, "generated/demo/types/base.ts"), "utf8");
    assert.match(generated, /__proto__/);

    await assert.rejects(
      generate({
        xapiForgeConfig: config([service("base")], {
          hooks: {
            async transformSwagger(swagger) {
              swagger.components.schemas.SpecialDto.example = Number.NaN;
              return swagger;
            },
          },
        }),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated-invalid-json",
      }),
      /OpenAPI 文档只能包含有限数字/,
    );
    assert.equal(existsSync(join(root, "generated-invalid-json")), false);
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

test("internal references resolve escaped JSON Pointer tokens before generation", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "base",
      document({
        schemas: {
          "Escaped/Name~Dto": {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          ConsumerDto: { $ref: "#/components/schemas/Escaped~1Name~0Dto" },
        },
      }),
    );
    await generate({
      xapiForgeConfig: config([service("base")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    const generated = await readFile(join(root, "generated/demo/types/base.ts"), "utf8");
    assert.match(generated, /ConsumerDto/);

    await writeSwagger(
      root,
      "base",
      document({ schemas: { ConsumerDto: { $ref: "#/components/schemas/MissingDto" } } }),
    );
    const previous = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    await assert.rejects(
      generate({
        xapiForgeConfig: config([service("base")]),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      /内部 \$ref 无法解析："#\/components\/schemas\/MissingDto"/,
    );
    assert.equal(await readFile(join(root, "generated/demo/api-types.ts"), "utf8"), previous);
  });
});

test("client config supports intentional simple and layered v2 forms", async () => {
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
    const cfg = config([service("identity"), service("infrastructure")]);
    await generate({
      xapiForgeConfig: cfg,
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });

    const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(apiTypes, /export interface SchemasByService/);
    assert.match(apiTypes, /export type SchemaOf</);
    assert.match(apiTypes, /export namespace IdentitySchemas/);
    assert.match(apiTypes, /export type UserDto = SchemaOf<"identity", "Shared\.UserDto">/);
    assert.match(apiTypes, /export namespace InfrastructureSchemas/);
    assert.match(apiTypes, /export type UserDto = SchemaOf<"infrastructure", "Shared\.UserDto">/);
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

test("prefix namespaces stay nested inside service namespaces and rule order is stable", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "base",
      document({ schemas: { "Company.Module.UserDto": { type: "object" } } }),
    );
    const rules = [
      { match: "Company.", namespace: "Company" },
      { service: "base", match: "Company.Module.", namespace: "Module" },
    ];
    const options = { projectId: "demo", swaggerDir: "swagger", outputDir: "generated" };
    await generate({
      ...options,
      xapiForgeConfig: config([service("base")], {
        typeExports: { namespaces: rules },
      }),
    });
    const baseline = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(baseline, /export namespace BaseSchemas/);
    assert.match(baseline, /  export namespace Module/);
    assert.match(baseline, /export type UserDto = SchemaOf<"base", "Company\.Module\.UserDto">/);
    assert.doesNotMatch(baseline, /  export namespace Company/);

    const reordered = await generate({
      ...options,
      xapiForgeConfig: config([service("base")], {
        typeExports: { namespaces: [...rules].reverse() },
      }),
    });
    assert.equal(reordered.changed, false);
  });
});

test("generic schema names stay canonical unless an explicit stable alias is configured", async () => {
  await withTempProject(async (root) => {
    const genericName = "Fixture.PagedResult`1[Fixture.ItemDto]";
    await writeSwagger(
      root,
      "base",
      document({
        schemas: {
          [genericName]: {
            type: "object",
            properties: { total: { type: "integer" } },
          },
        },
      }),
    );
    await generate({
      xapiForgeConfig: config([service("base")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    let apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.doesNotMatch(apiTypes, /export type PagedResult/);

    await writeFile(
      join(root, "generic-usage.ts"),
      `import type { SchemaOf } from "./generated/demo/api-types.js";
const page: SchemaOf<"base", ${JSON.stringify(genericName)}> = { total: 1 };
void page;
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
        include: ["generic-usage.ts"],
      }),
      "utf8",
    );
    const compiled = spawnSync(process.execPath, [tscPath, "-p", join(root, "tsconfig.json")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);

    await generate({
      xapiForgeConfig: config([service("base")], {
        typeExports: {
          aliases: [{ service: "base", schema: genericName, exportAs: "ItemPage" }],
        },
      }),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(apiTypes, /export type ItemPage = SchemaOf<"base"/);
  });
});

test("a service with no components.schemas still has a valid canonical service entry", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(root, "empty", {
      openapi: "3.0.3",
      info: { title: "Schema-less fixture", version: "1.0.0" },
      paths: {},
    });
    await generate({
      xapiForgeConfig: config([service("empty")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(apiTypes, /"empty": EmptyComponents\["schemas"\]/);
    assert.match(apiTypes, /export namespace EmptySchemas/);

    await writeFile(
      join(root, "empty-usage.ts"),
      `import type { SchemasByService, ServiceName } from "./generated/demo/api-types.js";
const service: ServiceName = "empty";
type EmptySchemas = SchemasByService["empty"];
type AssertNever<T extends never> = T;
type EmptyServiceHasNoSchemas = AssertNever<EmptySchemas>;
void service;
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
        include: ["empty-usage.ts"],
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

test("flat-strict emits project-level aliases and prefix namespaces", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "catalog",
      document({
        schemas: {
          "Fixture.Catalog.ProductDto": {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          "Fixture.Shared.PageInfo": {
            type: "object",
            properties: { total: { type: "number" } },
          },
        },
      }),
    );
    await writeSwagger(
      root,
      "billing",
      document({
        schemas: {
          "Fixture.Billing.InvoiceDto": {
            type: "object",
            required: ["amount"],
            properties: { amount: { type: "number" } },
          },
        },
      }),
    );
    await generate({
      xapiForgeConfig: config([service("catalog"), service("billing")], {
        typeExports: {
          strategy: "flat-strict",
          namespaces: [{ service: "catalog", match: "Fixture.Catalog.", namespace: "Catalog" }],
        },
      }),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });

    const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(apiTypes, /export namespace Catalog/);
    assert.match(
      apiTypes,
      /export type ProductDto = SchemaOf<"catalog", "Fixture\.Catalog\.ProductDto">/,
    );
    assert.match(
      apiTypes,
      /export type PageInfo = SchemaOf<"catalog", "Fixture\.Shared\.PageInfo">/,
    );
    assert.match(
      apiTypes,
      /export type InvoiceDto = SchemaOf<"billing", "Fixture\.Billing\.InvoiceDto">/,
    );
    assert.doesNotMatch(apiTypes, /export namespace (Catalog|Billing)Schemas/);

    await writeFile(
      join(root, "flat-usage.ts"),
      `import type { Catalog, InvoiceDto, PageInfo } from "./generated/demo/api-types.js";
const product: Catalog.ProductDto = { id: "p-1" };
const invoice: InvoiceDto = { amount: 10 };
const page: PageInfo = { total: 1 };
void product;
void invoice;
void page;
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
        include: ["flat-usage.ts"],
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

test("flat-strict rejects cross-service and canonical-name collisions", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "identity",
      document({ schemas: { "Identity.UserDto": { type: "object" } } }),
    );
    await writeSwagger(
      root,
      "billing",
      document({ schemas: { "Billing.UserDto": { type: "object" } } }),
    );
    const services = [service("identity"), service("billing")];
    await assert.rejects(
      generate({
        xapiForgeConfig: config(services, {
          typeExports: { strategy: "flat-strict" },
        }),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      (error) => {
        assert.match(error.message, /schema alias 冲突：UserDto/);
        assert.match(error.message, /billing\/Billing\.UserDto/);
        assert.match(error.message, /identity\/Identity\.UserDto/);
        return true;
      },
    );
    assert.equal(existsSync(join(root, "generated")), false);

    await generate({
      xapiForgeConfig: config(services, {
        typeExports: {
          strategy: "flat-strict",
          aliases: [{ service: "billing", schema: "Billing.UserDto", exportAs: "BillingUserDto" }],
        },
      }),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    const resolved = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(resolved, /export type UserDto = SchemaOf<"identity", "Identity\.UserDto">/);
    assert.match(resolved, /export type BillingUserDto = SchemaOf<"billing", "Billing\.UserDto">/);

    await writeSwagger(
      root,
      "identity",
      document({ schemas: { "Fixture.SchemaOf": { type: "object" } } }),
    );
    await assert.rejects(
      generate({
        xapiForgeConfig: config([service("identity")], {
          typeExports: { strategy: "flat-strict" },
        }),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated-reserved",
      }),
      /flat-strict 顶层名称 "SchemaOf" 与 canonical\/import 名称冲突/,
    );

    await writeSwagger(
      root,
      "identity",
      document({
        schemas: {
          "Fixture.Group": { type: "object" },
          "Fixture.Nested.ItemDto": { type: "object" },
        },
      }),
    );
    await assert.rejects(
      generate({
        xapiForgeConfig: config([service("identity")], {
          typeExports: {
            strategy: "flat-strict",
            namespaces: [{ match: "Fixture.Nested.", namespace: "Group" }],
          },
        }),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated-alias-namespace",
      }),
      /flat-strict 顶层 namespace "Group" 与同名 alias 冲突/,
    );
  });
});

test("adding, changing, or deleting an unrelated schema preserves stable public imports", async () => {
  await withTempProject(async (root) => {
    const stableSchema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    };
    const variants = [
      { "Stable.Dto": stableSchema, "Mutable.Dto": { type: "string" } },
      {
        "Added.FlagDto": { type: "boolean" },
        "Stable.Dto": stableSchema,
        "Mutable.Dto": { type: "number" },
      },
      { "Stable.Dto": stableSchema, "Added.FlagDto": { type: "boolean" } },
    ];
    const options = {
      xapiForgeConfig: config([service("base")]),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    };
    const stableExport = 'export type Dto = SchemaOf<"base", "Stable.Dto">;';

    // Mutable.Dto 与 Stable.Dto 的自动短名都叫 Dto；给 mutable identity 一个固定例外名。
    options.xapiForgeConfig.projects[0].typeExports = {
      aliases: [{ service: "base", schema: "Mutable.Dto", exportAs: "MutableDto" }],
    };
    await writeSwagger(root, "base", document({ schemas: variants[0] }));
    await generate(options);
    const baselineTypes = await readFile(join(root, "generated/demo/types/base.ts"), "utf8");
    const baselineStableLines = baselineTypes
      .split("\n")
      .filter((line) => line.includes('"Stable.Dto"') || line.includes("id: string"));

    for (const schemas of variants.slice(1)) {
      // 删除 Mutable.Dto 时，相应显式 alias 也必须删除；Stable.Dto 的 identity 不变。
      options.xapiForgeConfig.projects[0].typeExports =
        "Mutable.Dto" in schemas
          ? { aliases: [{ service: "base", schema: "Mutable.Dto", exportAs: "MutableDto" }] }
          : undefined;
      await writeSwagger(root, "base", document({ schemas }));
      await generate(options);
      const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
      assert.ok(apiTypes.includes(stableExport));
      const currentTypes = await readFile(join(root, "generated/demo/types/base.ts"), "utf8");
      assert.deepEqual(
        currentTypes
          .split("\n")
          .filter((line) => line.includes('"Stable.Dto"') || line.includes("id: string")),
        baselineStableLines,
      );
    }

    await writeFile(
      join(root, "stable-usage.ts"),
      `import type { BaseSchemas } from "./generated/demo/api-types.js";
const stable: BaseSchemas.Dto = { id: "unchanged" };
void stable;
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
        include: ["stable-usage.ts"],
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

test("only same-service alias collisions fail; explicit aliases resolve them", async () => {
  await withTempProject(async (root) => {
    await writeSwagger(
      root,
      "identity",
      document({
        schemas: {
          "First.UserDto": { type: "object" },
          "Second.UserDto": { type: "object" },
        },
      }),
    );
    await writeSwagger(
      root,
      "infrastructure",
      document({ schemas: { "Shared.UserDto": { type: "object" } } }),
    );
    const services = [service("identity"), service("infrastructure")];
    await assert.rejects(
      generate({
        xapiForgeConfig: config(services),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      (error) => {
        assert.match(error.message, /schema alias 冲突：IdentitySchemas\.UserDto/);
        assert.match(error.message, /identity\/First\.UserDto/);
        assert.match(error.message, /identity\/Second\.UserDto/);
        return true;
      },
    );
    assert.equal(existsSync(join(root, "generated")), false);

    await generate({
      xapiForgeConfig: config(services, {
        typeExports: {
          aliases: [{ service: "identity", schema: "First.UserDto", exportAs: "FirstUserDto" }],
        },
      }),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(apiTypes, /export type FirstUserDto = SchemaOf<"identity", "First\.UserDto">/);
    assert.match(apiTypes, /export type UserDto = SchemaOf<"infrastructure", "Shared\.UserDto">/);

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

    const previous = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    await writeSwagger(
      root,
      "identity",
      document({
        schemas: {
          "Fixture.Group": { type: "object" },
          "Fixture.Nested.ItemDto": { type: "object" },
        },
      }),
    );
    await assert.rejects(
      generate({
        xapiForgeConfig: config(services, {
          typeExports: {
            namespaces: [{ service: "identity", match: "Fixture.Nested.", namespace: "Group" }],
          },
        }),
        projectId: "demo",
        swaggerDir: "swagger",
        outputDir: "generated",
      }),
      /IdentitySchemas 下 namespace "Group" 与同名 alias 冲突/,
    );
    assert.equal(await readFile(join(root, "generated/demo/api-types.ts"), "utf8"), previous);
  });
});

test("canonical-only emits only service-scoped canonical schema access", async () => {
  await withTempProject(async (root) => {
    for (const serviceName of ["identity", "infrastructure"]) {
      await writeSwagger(
        root,
        serviceName,
        document({ schemas: { "Shared.UserDto": { type: "object" } } }),
      );
    }
    assert.throws(
      () =>
        validateConfig(
          config([service("identity"), service("infrastructure")], {
            typeExports: {
              strategy: "canonical-only",
              namespaces: [{ match: "Shared.", namespace: "Shared" }],
            },
          }),
        ),
      /strategy=canonical-only 不能同时配置 namespace 或 alias/,
    );
    await generate({
      xapiForgeConfig: config([service("identity"), service("infrastructure")], {
        typeExports: { strategy: "canonical-only" },
      }),
      projectId: "demo",
      swaggerDir: "swagger",
      outputDir: "generated",
    });
    const apiTypes = await readFile(join(root, "generated/demo/api-types.ts"), "utf8");
    assert.match(apiTypes, /export interface SchemasByService/);
    assert.match(apiTypes, /export type SchemaOf</);
    assert.doesNotMatch(apiTypes, /export namespace .*Schemas/);
    assert.doesNotMatch(apiTypes, /AllSchemas/);
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
      timeoutMs: 15_000,
      outputDir: "swagger",
      mode: "offline",
      projects: [
        {
          name: "first",
          displayName: "First",
          services: [service("base", { source: { file: "swagger/first/base.json" } })],
        },
        {
          name: "second",
          displayName: "Second",
          services: [service("base", { source: { file: "swagger/second/base.json" } })],
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
