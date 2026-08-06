#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PACKAGE_FILES = [
  "package.json",
  "packages/core/package.json",
  "packages/genapi/package.json",
  "packages/adapter-browser/package.json",
  "packages/adapter-capacitor/package.json",
  "packages/adapter-react-native/package.json",
  "packages/vconsole-debug/package.json",
] as const;

async function main(): Promise<void> {
  const version = process.argv[2];

  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("用法: pnpm release:version <version>，例如 pnpm release:version 0.1.5");
  }

  let updated = 0;
  for (const relativePath of PACKAGE_FILES) {
    const filePath = resolve(relativePath);
    const packageJson = JSON.parse(await readFile(filePath, "utf8")) as {
      name?: string;
      version?: string;
    };

    if (packageJson.version === version) {
      console.log(`${relativePath}: 已是 ${version}`);
      continue;
    }

    packageJson.version = version;
    await writeFile(filePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    console.log(`${relativePath}: -> ${version}`);
    updated++;
  }

  if (updated === 0) {
    console.log("所有 package.json 版本一致，无需修改。");
  } else {
    console.log(
      "版本号已更新。接下来更新 CHANGELOG.md，再运行 pnpm verify 和 pnpm publish:dry-run。",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
