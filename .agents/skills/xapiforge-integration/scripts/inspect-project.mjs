#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const openApiName = /^(?:openapi|swagger)(?:[.-].*)?\.(?:json|ya?ml)$/i;
const structuredDocument = /\.(?:json|ya?ml)$/i;
const openApiDirectory = /^(?:openapi|swagger)(?:[._-].*)?$/i;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson() {
  const path = join(projectRoot, "package.json");
  if (!(await exists(path))) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function findOpenApiFiles(directory, depth = 0, results = []) {
  if (depth > 4 || results.length >= 100) return results;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= 100) break;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await findOpenApiFiles(path, depth + 1, results);
      }
    } else {
      const relativePath = path.slice(projectRoot.length + 1);
      const directorySignalsOpenApi = relativePath
        .split(/[\\/]/)
        .slice(0, -1)
        .some((segment) => openApiDirectory.test(segment));
      if (
        openApiName.test(entry.name) ||
        (structuredDocument.test(entry.name) && directorySignalsOpenApi)
      ) {
        results.push(relativePath);
      }
    }
  }
  return results;
}

const manifest = await readPackageJson();
const dependencyGroups = manifest
  ? [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
  : [];
const dependencies = Object.assign({}, ...dependencyGroups.filter(Boolean));
const hasDependency = (name) => Object.hasOwn(dependencies, name);

const lockfileCandidates = [
  ["pnpm", "pnpm-lock.yaml"],
  ["npm", "package-lock.json"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
];
const lockfiles = [];
for (const [manager, file] of lockfileCandidates) {
  if (await exists(join(projectRoot, file))) lockfiles.push({ manager, file });
}
const declaredPackageManager =
  typeof manifest?.packageManager === "string"
    ? (manifest.packageManager.match(/^(pnpm|npm|yarn|bun)@/)?.[1] ?? null)
    : null;

const runtimeSignals = {
  capacitor: hasDependency("@capacitor/core"),
  expo: hasDependency("expo"),
  ionic: Object.keys(dependencies).some((name) => name.startsWith("@ionic/")),
  react: hasDependency("react"),
  reactNative: hasDependency("react-native"),
  vue: hasDependency("vue"),
};

const installedAdapters = Object.keys(dependencies).filter((name) =>
  name.startsWith("@xapiforge/adapter-"),
);
let recommendedAdapter = null;
if (runtimeSignals.reactNative || runtimeSignals.expo) {
  recommendedAdapter = "@xapiforge/adapter-react-native";
} else if (runtimeSignals.capacitor) {
  recommendedAdapter = "@xapiforge/adapter-capacitor";
} else if (runtimeSignals.vue || runtimeSignals.react || runtimeSignals.ionic) {
  recommendedAdapter = "@xapiforge/adapter-browser";
} else if (installedAdapters.length === 1) {
  [recommendedAdapter] = installedAdapters;
}

const configCandidates = [];
for (const file of ["xapiforge.config.ts", "xapiforge.config.js"]) {
  if (await exists(join(projectRoot, file))) configCandidates.push(file);
}
const unsupportedConfigCandidates = [];
for (const file of ["xapiforge.config.mts", "xapiforge.config.mjs"]) {
  if (await exists(join(projectRoot, file))) unsupportedConfigCandidates.push(file);
}

const projectSignals = [];
for (const file of [
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "capacitor.config.ts",
  "capacitor.config.json",
  "app.json",
  "metro.config.js",
]) {
  if (await exists(join(projectRoot, file))) projectSignals.push(file);
}

const xapiforgeDependencies = Object.fromEntries(
  Object.entries(dependencies).filter(([name]) => name.startsWith("@xapiforge/")),
);
const relevantScripts = Object.fromEntries(
  Object.entries(manifest?.scripts ?? {}).filter(([name, command]) =>
    /xapiforge|swagger|openapi|typecheck|build|lint|test|verify/i.test(
      `${name} ${String(command)}`,
    ),
  ),
);

const warnings = [];
const packageManagers = new Set(lockfiles.map(({ manager }) => manager));
if (!manifest) warnings.push("package.json was not found");
if (packageManagers.size > 1) warnings.push("multiple package-manager lockfiles were found");
if (packageManagers.size === 0) warnings.push("no package-manager lockfile was found");
if (!recommendedAdapter)
  warnings.push(
    "runtime is ambiguous; inspect application entry files before selecting an adapter",
  );
if (unsupportedConfigCandidates.length > 0) {
  warnings.push(
    `unsupported xapiforge config extension: ${unsupportedConfigCandidates.join(", ")}; use xapiforge.config.ts or xapiforge.config.js`,
  );
}

console.log(
  JSON.stringify(
    {
      projectRoot,
      projectName: manifest?.name ?? basename(projectRoot),
      packageManager: packageManagers.size === 1 ? [...packageManagers][0] : declaredPackageManager,
      declaredPackageManager,
      lockfiles,
      runtimeSignals,
      recommendedAdapter,
      xapiforgeDependencies,
      configCandidates,
      unsupportedConfigCandidates,
      openApiFiles: await findOpenApiFiles(projectRoot),
      projectSignals,
      relevantScripts,
      warnings,
    },
    null,
    2,
  ),
);
