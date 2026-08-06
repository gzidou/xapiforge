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
      "  --otp <code>                 npm 2FA one-time password",
      "  --dry-run                    Pack and validate without publishing. Default",
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

  for (const pkg of PACKAGE_ORDER) {
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
    if (args.dryRun) publishArgs.push("--dry-run");
    if (args.otp) publishArgs.push("--otp", args.otp);

    console.log(`\n━━━ ${pkg} ━━━`);
    run("pnpm", publishArgs);
  }
}

try {
  main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
