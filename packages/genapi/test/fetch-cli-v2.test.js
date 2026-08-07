import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

    const sizeLimited = config("online", server.url, [
      {
        name: "remote",
        displayName: "Remote OpenAPI",
        source: { url: server.url },
      },
    ]);
    sizeLimited.maxSwaggerBytes = 8;
    await writeConfig(root, sizeLimited);
    const oversizedRemote = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(oversizedRemote.status, 1, `${oversizedRemote.stdout}\n${oversizedRemote.stderr}`);
    assert.match(oversizedRemote.stdout, /超过最大允许大小 8 B/);
    assert.deepEqual(JSON.parse(await readFile(remoteCache, "utf8")), openApiDocument);

    await stopServer(server.child);
    await writeConfig(root, config("offline", server.url));
    const offline = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(offline.status, 0, `${offline.stdout}\n${offline.stderr}`);
    assert.match(offline.stdout, /cache:.*remote\.json/);
    assert.match(offline.stdout, /local.*file:/);

    const dryUrl =
      "http://127.0.0.1:1/must-not-be-requested.json?token=must-not-leak&tenant=stable";
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
    assert.doesNotMatch(dryRun.stdout, /must-not-leak/);
    assert.match(dryRun.stdout, /tenant=stable/);
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

    await mkdir(join(root, "fixtures/not-a-file.json"), { recursive: true });
    await writeConfig(
      root,
      config("offline", dryUrl, [
        {
          name: "directory",
          displayName: "Directory source",
          source: { file: "fixtures/not-a-file.json" },
        },
      ]),
    );
    const directorySource = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(directorySource.status, 1, `${directorySource.stdout}\n${directorySource.stderr}`);
    assert.match(directorySource.stdout, /不是普通文件或指向普通文件的 symlink/);

    const localSizeLimited = config("offline", dryUrl, [
      {
        name: "local",
        displayName: "Local OpenAPI",
        source: { file: "fixtures/not-the-service-id.json" },
      },
    ]);
    localSizeLimited.maxSwaggerBytes = 8;
    await writeConfig(root, localSizeLimited);
    const oversizedLocal = spawnSync(process.execPath, [fetchCliPath], spawnOptions);
    assert.equal(oversizedLocal.status, 1, `${oversizedLocal.stdout}\n${oversizedLocal.stderr}`);
    assert.match(oversizedLocal.stdout, /超过 maxSwaggerBytes \(8 B\)/);
  } finally {
    await stopServer(server.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("fetch CLI rejects missing, empty, and unknown --only values", async () => {
  const root = await mkdtemp(join(tmpdir(), "xapiforge-fetch-only-"));
  const spawnOptions = { cwd: root, encoding: "utf8" };
  try {
    const missing = spawnSync(process.execPath, [fetchCliPath, "--only"], spawnOptions);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--only 缺少参数值/);

    const empty = spawnSync(process.execPath, [fetchCliPath, "--only", ",,"], spawnOptions);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /--only 至少需要一个 project ID/);

    await mkdir(join(root, "fixtures"), { recursive: true });
    await writeFile(join(root, "fixtures/local.json"), JSON.stringify(openApiDocument), "utf8");
    await writeConfig(
      root,
      config("offline", "https://example.test/unused.json", [
        {
          name: "local",
          displayName: "Local OpenAPI",
          source: { file: "fixtures/local.json" },
        },
      ]),
    );

    const mixed = spawnSync(
      process.execPath,
      [fetchCliPath, "--only", "demo,misspelled"],
      spawnOptions,
    );
    assert.equal(mixed.status, 1);
    assert.match(mixed.stderr, /--only 包含未知 project：misspelled/);

    const selected = spawnSync(process.execPath, [fetchCliPath, "--only", "demo"], spawnOptions);
    assert.equal(selected.status, 0, `${selected.stdout}\n${selected.stderr}`);
    assert.match(selected.stdout, /demo\/local.*file:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fetch CLI rejects a remote cache that would overwrite a file source", async () => {
  const root = await mkdtemp(join(tmpdir(), "xapiforge-fetch-collision-"));
  const remoteUrl = "http://127.0.0.1:1/must-not-be-requested.json";
  try {
    let localSourcePath = "swagger-cache/remote-project/remote.json";
    if (process.platform !== "win32") {
      await mkdir(join(root, "aliases"));
      localSourcePath = "aliases/remote.json";
      await symlink("../swagger-cache/remote-project/remote.json", join(root, localSourcePath));
    }
    await writeConfig(root, {
      timeoutMs: 1_000,
      outputDir: "swagger-cache",
      mode: "online",
      projects: [
        {
          name: "remote-project",
          displayName: "Remote project",
          services: [
            {
              name: "remote",
              displayName: "Remote OpenAPI",
              source: { url: remoteUrl },
            },
          ],
        },
        {
          name: "local-project",
          displayName: "Local project",
          services: [
            {
              name: "local",
              displayName: "Local OpenAPI",
              source: { file: localSourcePath },
            },
          ],
        },
      ],
    });
    const result = spawnSync(process.execPath, [fetchCliPath, "--only", "remote-project"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /远程 source remote-project\/remote 的缓存会覆盖本地 source local-project\/local/,
    );
    await assert.rejects(readFile(join(root, "swagger-cache/remote-project/remote.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
