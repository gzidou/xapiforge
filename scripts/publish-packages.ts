#!/usr/bin/env node
/**
 * Publish xapiforge workspace packages to a selected npm registry.
 *
 * Safety model:
 * - dry-run is the default;
 * - any real publish requires --confirm;
 * - registry selection is explicit: local / npm / custom;
 * - package order is dependency-aware, so @xapiforge/core is published first.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_LOCAL_REGISTRY = "http://localhost:4873";
const NPM_REGISTRY = "https://registry.npmjs.org/";

const PACKAGE_ORDER = [
  "@xapiforge/core",
  "@xapiforge/genapi",
  "@xapiforge/adapter-browser",
  "@xapiforge/adapter-capacitor",
  "@xapiforge/adapter-react-native",
  "@xapiforge/vconsole-debug",
] as const;

const PACKAGE_MANIFESTS: Readonly<Record<(typeof PACKAGE_ORDER)[number], string>> = {
  "@xapiforge/core": "packages/core/package.json",
  "@xapiforge/genapi": "packages/genapi/package.json",
  "@xapiforge/adapter-browser": "packages/adapter-browser/package.json",
  "@xapiforge/adapter-capacitor": "packages/adapter-capacitor/package.json",
  "@xapiforge/adapter-react-native": "packages/adapter-react-native/package.json",
  "@xapiforge/vconsole-debug": "packages/vconsole-debug/package.json",
};

interface PublishArgs {
  target: "local" | "npm" | "custom";
  registry: string;
  tag: string;
  otp: string;
  fromPackage: string;
  authCheck: boolean;
  dryRun: boolean;
  confirm: boolean;
  help: boolean;
}

function parseTarget(value: string): PublishArgs["target"] {
  if (value === "local" || value === "npm" || value === "custom") return value;
  throw new Error(`Unsupported target: ${value}`);
}

function parseArgs(argv: string[]): PublishArgs {
  const out: PublishArgs = {
    target: "local",
    registry: "",
    tag: "",
    otp: "",
    fromPackage: "",
    authCheck: false,
    dryRun: true,
    confirm: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") out.target = parseTarget(argv[++i] ?? "");
    else if (arg === "--registry") out.registry = argv[++i] ?? "";
    else if (arg === "--tag") out.tag = argv[++i] ?? "";
    else if (arg === "--otp") out.otp = argv[++i] ?? "";
    else if (arg === "--from") out.fromPackage = argv[++i] ?? "";
    else if (arg === "--auth-check") out.authCheck = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--confirm") {
      out.confirm = true;
      out.dryRun = false;
    } else if (arg === "-h" || arg === "--help") out.help = true;
    else throw new Error(`Unknown option: ${arg ?? ""}`);
  }

  return out;
}

function printHelp(): void {
  console.log(
    [
      "Usage: tsx scripts/publish-packages.ts [options]",
      "",
      "Options:",
      "  --target <local|npm|custom>  Select registry target. Default: local",
      "  --registry <url>             Registry URL for custom target",
      "  --tag <tag>                  npm dist-tag. Default: prerelease id or latest",
      "  --otp <code>                 Numeric code from an authenticator app",
      "  --from <package>             Resume at this package after a partial publish",
      "  --auth-check                 Check npm authentication, then exit",
      "  --dry-run                    Create and validate temporary tarballs. Default",
      "  --confirm                    Actually publish to the selected registry",
      "  -h, --help                   Show help",
      "",
      "Environment:",
      `  XAPIFORGE_LOCAL_NPM_REGISTRY  Local registry URL. Default: ${DEFAULT_LOCAL_REGISTRY}`,
    ].join("\n"),
  );
}

function resolveRegistry(args: PublishArgs): string {
  if (args.target === "local") {
    return process.env.XAPIFORGE_LOCAL_NPM_REGISTRY || DEFAULT_LOCAL_REGISTRY;
  }
  if (args.target === "npm") return NPM_REGISTRY;
  if (!args.registry) {
    throw new Error("--target custom requires --registry <url>");
  }
  return args.registry;
}

function readReleaseVersion(): string {
  const versions = PACKAGE_ORDER.map((name) => {
    const manifest = JSON.parse(readFileSync(PACKAGE_MANIFESTS[name], "utf8")) as {
      name?: string;
      version?: string;
    };
    if (manifest.name !== name || !manifest.version) {
      throw new Error(`Invalid package manifest: ${PACKAGE_MANIFESTS[name]}`);
    }
    return { name, version: manifest.version };
  });
  const uniqueVersions = new Set(versions.map(({ version }) => version));
  if (uniqueVersions.size !== 1) {
    throw new Error(
      `Public package versions must match:\n${versions.map(({ name, version }) => `  ${name}: ${version}`).join("\n")}`,
    );
  }
  return versions[0]!.version;
}

function resolveTag(explicitTag: string, version: string): string {
  if (explicitTag) return explicitTag;
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)(?:\.|$)/.exec(version)?.[1];
  return prerelease ?? "latest";
}

function childEnvironment(command: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (command === "npm") {
    delete environment.npm_config_store_dir;
    delete environment.NPM_CONFIG_STORE_DIR;
  }
  return environment;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: childEnvironment(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: childEnvironment(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function verifyNpmAuth(registry: string): void {
  const username = capture("npm", ["whoami", "--registry", registry]).trim();
  if (!username) throw new Error(`npm whoami returned an empty username for ${registry}`);
  console.log(`npm user: ${username}`);
}

function verifyPublishedPackage(
  packageName: (typeof PACKAGE_ORDER)[number],
  version: string,
  tag: string,
  registry: string,
): void {
  const publishedVersion = JSON.parse(
    capture("npm", [
      "view",
      `${packageName}@${version}`,
      "version",
      "--json",
      "--registry",
      registry,
    ]),
  ) as unknown;
  if (publishedVersion !== version) {
    throw new Error(
      `Published version verification failed for ${packageName}: expected ${version}, received ${String(publishedVersion)}`,
    );
  }

  const distTags = JSON.parse(
    capture("npm", ["view", packageName, "dist-tags", "--json", "--registry", registry]),
  ) as unknown;
  if (
    typeof distTags !== "object" ||
    distTags === null ||
    !(tag in distTags) ||
    (distTags as Record<string, unknown>)[tag] !== version
  ) {
    throw new Error(
      `Dist-tag verification failed for ${packageName}: expected ${tag} -> ${version}`,
    );
  }

  console.log(`verified: ${packageName}@${version} (${tag})`);
}

function validateTarball(archivePath: string): void {
  const entries = capture("tar", ["-tzf", archivePath])
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const forbidden = entries.filter(
    (entry) =>
      entry.endsWith(".map") ||
      entry.includes("/src/") ||
      entry.includes("/test/") ||
      entry.includes("/type-tests/") ||
      entry.endsWith(".tsbuildinfo") ||
      entry.endsWith("/.npmrc") ||
      entry.includes("/.env"),
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden files in ${archivePath}:\n${forbidden.join("\n")}`);
  }

  const required = ["package/package.json", "package/README.md", "package/LICENSE"];
  const missing = required.filter((entry) => !entries.includes(entry));
  if (!entries.some((entry) => entry.startsWith("package/dist/") && entry.endsWith(".js"))) {
    missing.push("package/dist/*.js");
  }
  if (!entries.some((entry) => entry.startsWith("package/dist/") && entry.endsWith(".d.ts"))) {
    missing.push("package/dist/*.d.ts");
  }
  if (missing.length > 0) {
    throw new Error(`Required files missing from ${archivePath}: ${missing.join(", ")}`);
  }

  const sizeKiB = (statSync(archivePath).size / 1024).toFixed(1);
  console.log(`validated: ${archivePath} (${entries.length} files, ${sizeKiB} KiB)`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const registry = resolveRegistry(args);
  const version = readReleaseVersion();
  const tag = resolveTag(args.tag, version);
  if (args.authCheck && args.target !== "npm") {
    throw new Error("--auth-check requires --target npm");
  }
  if (!args.dryRun && !args.confirm) {
    throw new Error("Real publish requires --confirm");
  }

  if (args.target === "npm" && (args.authCheck || !args.dryRun)) {
    verifyNpmAuth(registry);
  }
  if (args.authCheck) return;

  console.log(`xapiforge publish target: ${args.target}`);
  console.log(`registry: ${registry}`);
  console.log(`version: ${version}`);
  console.log(`tag: ${tag}`);
  console.log(`mode: ${args.dryRun ? "dry-run" : "publish"}`);
  console.log("");

  const startIndex = args.fromPackage
    ? PACKAGE_ORDER.indexOf(args.fromPackage as (typeof PACKAGE_ORDER)[number])
    : 0;
  if (startIndex < 0) {
    throw new Error(`Unsupported --from package: ${args.fromPackage}`);
  }

  const packages = PACKAGE_ORDER.slice(startIndex);
  if (args.fromPackage) {
    console.log(`resume from: ${args.fromPackage}`);
  }

  const packDirectory = args.dryRun ? mkdtempSync(join(tmpdir(), "xapiforge-pack-")) : "";

  for (const pkg of packages) {
    console.log(`\n━━━ ${pkg} ━━━`);
    if (args.dryRun) {
      const before = new Set(readdirSync(packDirectory));
      run("pnpm", ["--filter", pkg, "exec", "pnpm", "pack", "--pack-destination", packDirectory]);
      const archive = readdirSync(packDirectory).find(
        (file) => file.endsWith(".tgz") && !before.has(file),
      );
      if (!archive) throw new Error(`pnpm pack did not create a tarball for ${pkg}`);
      validateTarball(join(packDirectory, archive));
      continue;
    }

    const publishArgs = [
      "--filter",
      pkg,
      "publish",
      "--registry",
      registry,
      "--access",
      "public",
      "--tag",
      tag,
      "--no-git-checks",
    ];
    if (args.otp) publishArgs.push("--otp", args.otp);

    run("pnpm", publishArgs);
    verifyPublishedPackage(pkg, version, tag, registry);
  }

  if (args.dryRun) {
    rmSync(packDirectory, { recursive: true, force: true });
    console.log("\nAll package tarballs passed validation; temporary files removed.");
  }
}

try {
  main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
