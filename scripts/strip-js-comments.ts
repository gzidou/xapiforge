#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { transform } from "esbuild";

async function findJavaScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJavaScriptFiles(entryPath)));
    } else if (entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error("Usage: pnpm exec tsx scripts/strip-js-comments.ts <dist-directory>");
  }

  for (const filePath of await findJavaScriptFiles(resolve(outputDirectory))) {
    const source = await readFile(filePath, "utf8");
    const result = await transform(source, {
      loader: "js",
      format: "esm",
      target: "es2022",
      legalComments: "none",
      minify: false,
      minifyWhitespace: true,
      sourcemap: false,
    });
    if (/(^|\n)\s*(?:\/\/|\/\*)/.test(result.code)) {
      throw new Error(`JavaScript comment remained after processing: ${filePath}`);
    }
    await writeFile(filePath, result.code, "utf8");
  }
}

void main();
