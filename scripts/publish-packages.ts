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
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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

interface PublishArgs {
  target: "local" | "npm" | "custom";
  registry: string;
  tag: string;
  otp: string;
  fromPackage: string;
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
    tag: "latest",
    otp: "",
    fromPackage: "",
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
      "  --tag <tag>                  npm dist-tag. Default: latest",
      "  --otp <code>                 Numeric code from an authenticator app",
      "  --from <package>             Resume at this package after a partial publish",
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

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}\n${result.stderr}`,
    );
  }
  return result.stdout;
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
  if (!args.dryRun && !args.confirm) {
    throw new Error("Real publish requires --confirm");
  }

  console.log(`xapiforge publish target: ${args.target}`);
  console.log(`registry: ${registry}`);
  console.log(`tag: ${args.tag}`);
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
      args.tag,
      "--no-git-checks",
    ];
    if (args.otp) publishArgs.push("--otp", args.otp);

    run("pnpm", publishArgs);
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
