import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generate, validateConfig } from "../dist/index.js";

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
