import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fetchCliPath = join(packageDir, "dist", "fetch-cli.js");

const openApiDocument = {
  openapi: "3.0.3",
  info: { title: "URL source fixture", version: "1.0.0" },
  paths: {},
};

async function startJsonServer(body) {
  const serverCode = `
    const { createServer } = require("node:http");
    const body = ${JSON.stringify(body)};
    const server = createServer((request, response) => {
      if (request.url !== "/openapi.json") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port) + "\\n");
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, ["-e", serverCode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [chunk] = await once(child.stdout, "data");
  const port = Number(String(chunk).trim());
  assert.ok(Number.isInteger(port) && port > 0, `invalid fixture server port: ${chunk}`);
  return { child, url: `http://127.0.0.1:${port}/openapi.json` };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

function config(mode, url, services) {
  return {
    timeoutMs: 1_000,
    outputDir: "swagger-cache",
    mode,
    projects: [
      {
        name: "demo",
        displayName: "Fetch CLI fixture",
        services: services ?? [
          {
            name: "remote",
            displayName: "Remote OpenAPI",
            source: { url },
          },
          {
            name: "local",
            displayName: "Local OpenAPI",
            source: { file: "fixtures/not-the-service-id.json" },
          },
        ],
      },
    ],
  };
}

async function writeConfig(root, value) {
  await writeFile(
    join(root, "xapiforge.config.js"),
    `module.exports = ${JSON.stringify(value, null, 2)};\n`,
    "utf8",
  );
}

test("fetch CLI covers URL online/cache offline/dry-run and direct file sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "xapiforge-fetch-v2-"));
  const server = await startJsonServer(JSON.stringify(openApiDocument));
  const spawnOptions = { cwd: root, encoding: "utf8" };
  try {
    await mkdir(join(root, "fixtures"), { recursive: true });
    await writeFile(
      join(root, "fixtures", "not-the-service-id.json"),
      JSON.stringify(openApiDocument),
      "utf8",
    );
    await writeConfig(root, config("online", server.url));

    const online = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(online.status, 0, `${online.stdout}\n${online.stderr}`);
    assert.match(online.stdout, /remote.*OK/);
    assert.match(online.stdout, /local.*file:/);
    const remoteCache = join(root, "swagger-cache", "demo", "remote.json");
    assert.deepEqual(JSON.parse(await readFile(remoteCache, "utf8")), openApiDocument);
    await assert.rejects(readFile(join(root, "swagger-cache", "demo", "local.json"), "utf8"));

    await stopServer(server.child);
    await writeConfig(root, config("offline", server.url));
    const offline = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(offline.status, 0, `${offline.stdout}\n${offline.stderr}`);
    assert.match(offline.stdout, /cache:.*remote\.json/);
    assert.match(offline.stdout, /local.*file:/);

    const dryUrl = "http://127.0.0.1:1/must-not-be-requested.json";
    await writeConfig(
      root,
      config("offline", dryUrl, [
        {
          name: "dry",
          displayName: "Dry-run OpenAPI",
          source: { url: dryUrl },
        },
      ]),
    );
    const dryRun = spawnSync(process.execPath, [fetchCliPath, "--dry-run"], spawnOptions);
    assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
    assert.match(dryRun.stdout, /OpenAPI source（dry-run）/);
    assert.match(dryRun.stdout, /\[dry\].*must-not-be-requested\.json/);
    await assert.rejects(readFile(join(root, "swagger-cache", "demo", "dry.json"), "utf8"));

    await writeConfig(
      root,
      config("offline", dryUrl, [
        {
          name: "missing",
          displayName: "Missing cached OpenAPI",
          source: { url: dryUrl },
        },
      ]),
    );
    const missingCache = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(missingCache.status, 1, `${missingCache.stdout}\n${missingCache.stderr}`);
    assert.match(missingCache.stdout, /\[FAIL\].*missing/);
  } finally {
    await stopServer(server.child);
    await rm(root, { recursive: true, force: true });
  }
});
