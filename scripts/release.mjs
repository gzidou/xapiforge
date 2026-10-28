#!/usr/bin/env node
/**
 * release.mjs — 把 xapiforge 六个包发到本机 Verdaccio 的「一条命令」。
 *
 * 为什么有这个文件：以前发版要人先算版本号、`pnpm release:version <版本>` 写七个 package.json、手写 CHANGELOG、再 `pnpm publish:local`，
 * 版本号算错就占掉一个号（已发布的不能覆盖）。2026-10-27 用户定下跨仓统一约定（zhsl-mh5-template 仓 docs/工程化与自动化方案.md
 * 第 4.1 节）：五个平台仓的 release 参数名、步骤顺序、守卫一致。本仓已有的 set-version.ts / publish-packages.ts 继续做改版本和发布，
 * 本脚本在外面补上「从 registry 算版本、变更记录、提交打 tag」。
 *
 * 用法（仓库根目录）：
 *   pnpm release --dry             演练：守卫 + 算版本 + 改版本 + 变更记录 + pnpm verify + publish-packages --dry-run，结束后还原文件
 *   pnpm release                   正式：同上，然后真正发布到本机私服（publish-packages 自己核对版本和 dist-tag）、提交并打 tag v<版本>
 *   pnpm release --bump minor      版本级别 pre | patch | minor | major；不给时：registry 最高版带预发布标识就 pre，否则 patch
 *   pnpm release --set 0.2.0       直接指定版本
 *
 * 步骤（任一步失败就停）：
 *   1 守卫：工作区干净（只允许本脚本管理的文件有改动）、本机私服能连
 *   2 算版本：读私服上六个包的全部版本取最高，按级别算下一个；本地高于私服视为上次发布中途失败，复用该号
 *   3 改版本：pnpm release:version <版本>（scripts/set-version.ts，七个 package.json）
 *   4 变更记录：从上一个 git tag（没有就从引入当前版本的提交）到 HEAD 的提交，按类型分组插进 CHANGELOG.md 的 `## Unreleased` 之后
 *     （本文件是英文、面向公网用户，分组用 Added / Fixed / Changed / Docs；手写的发布说明可以之后再补在该段开头）
 *   5 质量门 + 发布：pnpm verify，然后 tsx scripts/publish-packages.ts --target local（--dry 时 --dry-run，正式时 --confirm）
 *   6 提交：git add 受管文件，提交「chore(release): <版本>」，打 tag v<版本>。--dry 到第 5 步为止并还原第 3、4 步的文件
 *
 * dist-tag：由 publish-packages 决定（预发布标识当 tag，正式版 latest），**不**像内部仓那样把预发布也指到 latest——
 * 本仓发公网，0.1.x 用户要留在 latest 线上（见 CHANGELOG 0.2.0-alpha.0 说明）。
 * 不做：不发公网 npm（`pnpm publish:npm` 另走，须用户同意）；不 git push（远程 GitHub 由用户推）；不提供跳过 verify 的参数。
 * 中途失败（例如 core 发了、genapi 没发）：重跑本脚本会复用版本号，但 publish-packages 对已发布的包会报错，按它的提示用 `--from <包名>` 续发。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 六个发布包（顺序与 publish-packages.ts 的 PACKAGE_ORDER 一致，core 先发）。 */
const PACKAGES = [
  "@xapiforge/core",
  "@xapiforge/genapi",
  "@xapiforge/adapter-browser",
  "@xapiforge/adapter-capacitor",
  "@xapiforge/adapter-react-native",
  "@xapiforge/vconsole-debug",
];
/** set-version.ts 会改的文件 + CHANGELOG：守卫允许它们有未提交改动，最后只提交这些。 */
const MANAGED_FILES = [
  "package.json",
  "packages/core/package.json",
  "packages/genapi/package.json",
  "packages/adapter-browser/package.json",
  "packages/adapter-capacitor/package.json",
  "packages/adapter-react-native/package.json",
  "packages/vconsole-debug/package.json",
  "CHANGELOG.md",
];
/** 本机私服地址（与 publish-packages.ts 的 DEFAULT_LOCAL_REGISTRY 一致）。 */
const LOCAL_REGISTRY = "http://localhost:4873";
const BUMP_LEVELS = ["pre", "patch", "minor", "major"];
const PRERELEASE_ID = "alpha";

// ---------- 参数 ----------

/** 解析命令行。`['--dry', '--bump', 'minor']` → `{ dry: true, bump: 'minor', set: undefined }`；不认识的参数直接报错。 */
function parseArgs(argv) {
  const options = { dry: false, bump: undefined, set: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry") options.dry = true;
    else if (arg === "--bump") {
      options.bump = argv[++i];
      if (!BUMP_LEVELS.includes(options.bump))
        fail(`--bump 只能是 ${BUMP_LEVELS.join(" | ")}，收到 ${options.bump}`);
    } else if (arg === "--set") {
      options.set = argv[++i];
      if (!parseVersion(options.set))
        fail(`--set 需要合法的 semver 版本，例如 0.2.0 或 0.2.0-alpha.1，收到 ${options.set}`);
    } else fail(`不认识的参数 ${arg}，用法见文件头注释`);
  }
  if (options.bump && options.set) fail("--bump 与 --set 不能同时给");
  return options;
}

// ---------- 通用工具 ----------

/** --dry 中途失败时要执行的还原动作（改过版本号之后才设置）；正式发布不设，失败就保留现场、下次复用版本号重跑。 */
let cleanupOnFailure = null;

/** 打印错误并退出；所有「停下来」都走这里，保证退出码是 1，演练时顺手把改过的文件还原。 */
function fail(message) {
  console.error(`\n❌ ${message}`);
  if (cleanupOnFailure) {
    cleanupOnFailure();
    console.error("（演练中失败，已还原改过的文件）");
  }
  process.exit(1);
}

function step(title) {
  console.log(`\n== ${title}`);
}

/** 执行命令并把输出直接显示；失败即退出。 */
function run(command, args, { cwd = root } = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} 失败（退出码 ${result.status}）`);
}

/** 执行命令并返回标准输出；失败抛异常由调用方处理。 */
function output(command, args, { cwd = root } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** 今天的日期，形如 `2026-10-27`（本机时区）。 */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- 版本号 ----------

/**
 * 解析 semver。`0.2.0-alpha.0` → `{ major: 0, minor: 2, patch: 0, prerelease: ['alpha', 0] }`；不合法返回 null。
 * 正则：`^(\d+)\.(\d+)\.(\d+)` 主.次.补丁；`(?:-([0-9A-Za-z.-]+))?` 可选预发布标识；不接受 `+build`。
 */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text ?? "");
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // 预发布标识按点拆开，纯数字段转成数字（semver 规定数字段按数值比较，alpha.9 < alpha.10）
    prerelease: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

/** semver 比较：返回负 / 0 / 正。同号时没有预发布标识的更大；预发布逐段比，数字按数值、字符串按字典序、段数少的更小。 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) if (va[key] !== vb[key]) return va[key] - vb[key];
  if (!va.prerelease.length || !vb.prerelease.length)
    return vb.prerelease.length - va.prerelease.length;
  const length = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < length; i++) {
    const pa = va.prerelease[i];
    const pb = vb.prerelease[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    if (typeof pa === "number" && typeof pb === "number") return pa - pb;
    if (typeof pa === "number") return -1;
    if (typeof pb === "number") return 1;
    return pa < pb ? -1 : 1;
  }
  return 0;
}

/**
 * 按级别算下一个版本。bump('0.2.0-alpha.0', 'pre') → '0.2.0-alpha.1'；bump('0.2.0-alpha.0', 'patch') → '0.2.0'（转正 = 去掉标识）；
 * bump('0.1.4', 'patch') → '0.1.5'；bump('0.1.4', 'pre') → '0.1.5-alpha.0'。
 */
function bump(version, level) {
  const v = parseVersion(version);
  const base = `${v.major}.${v.minor}.${v.patch}`;
  if (level === "pre") {
    if (!v.prerelease.length) return `${v.major}.${v.minor}.${v.patch + 1}-${PRERELEASE_ID}.0`;
    const last = v.prerelease[v.prerelease.length - 1];
    const next =
      typeof last === "number" ? [...v.prerelease.slice(0, -1), last + 1] : [...v.prerelease, 1];
    return `${base}-${next.join(".")}`;
  }
  if (v.prerelease.length) return base;
  if (level === "patch") return `${v.major}.${v.minor}.${v.patch + 1}`;
  if (level === "minor") return `${v.major}.${v.minor + 1}.0`;
  return `${v.major + 1}.0.0`;
}

// ---------- registry ----------

/** 读私服上某包已发布的全部版本；包不存在（E404）返回 []。只有一个版本时 npm 返回字符串，统一成数组。 */
function publishedVersions(name, registry) {
  try {
    const json = output("npm", ["view", name, "versions", "--json", `--registry=${registry}`]);
    const parsed = json ? JSON.parse(json) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    if (String(error.stderr ?? error.message).includes("E404")) return [];
    fail(`查询 ${name} 的已发布版本失败：${error.stderr ?? error.message}`);
  }
}

// ---------- 变更记录 ----------

/**
 * 上一次发布的提交：最近的 `v*` tag；没有 tag 时找把当前版本写进 packages/core/package.json 的那次提交
 * （`git log -S<文本>` 列出让这段文本出现次数变化的提交，最早一条就是写进去的那次）。都没有返回 null。
 */
function previousReleaseCommit(currentVersion) {
  try {
    return output("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  } catch {
    const commits = output("git", [
      "log",
      `-S"version": "${currentVersion}"`,
      "--format=%H",
      "--",
      "packages/core/package.json",
    ]);
    const list = commits ? commits.split("\n") : [];
    return list.length ? list[list.length - 1] : null;
  }
}

/**
 * 读一段范围内的提交并按类型分组。git 输出用 `%x1f`（单元分隔符）隔字段、`%x1e`（记录分隔符）隔提交，这两个控制字符不会出现在提交信息里。
 * 跳过发布提交本身（chore(release) / chore(发布)）。
 */
function collectCommits(since) {
  const range = since ? `${since}..HEAD` : "HEAD";
  const raw = output("git", ["log", range, "--no-merges", "--format=%h%x1f%s%x1e"]);
  const groups = new Map();
  let count = 0;
  for (const record of raw.split("\x1e")) {
    const [hash, subject] = record.trim().split("\x1f");
    if (!subject) continue;
    const parsed = parseSubject(subject);
    if (parsed.type === "chore" && (parsed.scope === "release" || parsed.scope === "发布"))
      continue;
    count++;
    const group = groupName(parsed.type);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ scope: parsed.scope, subject: parsed.subject, hash });
  }
  return { groups, count };
}

/**
 * 拆 Conventional Commits 主题。`fix: harden npm publish workflow` → `{ type: 'fix', scope: null, subject: 'harden npm publish workflow' }`。
 * 正则：`^([a-z]+)` 类型；`(?:\(([^)]*)\))?` 可选括号 scope；`!?` 可选破坏性标记；`[:：]\s*` 半角或全角冒号；`(.+)$` 主题。
 */
function parseSubject(subject) {
  const match = /^([a-z]+)(?:\(([^)]*)\))?!?[:：]\s*(.+)$/.exec(subject);
  if (!match) return { type: null, scope: null, subject };
  return { type: match[1], scope: match[2] ?? null, subject: match[3] };
}

/** 提交类型 → 英文分组（本仓 CHANGELOG 面向公网用户，沿用 Keep a Changelog 的叫法）。 */
function groupName(type) {
  const names = {
    feat: "Added",
    fix: "Fixed",
    docs: "Docs",
    refactor: "Changed",
    perf: "Changed",
    revert: "Reverted",
  };
  return names[type] ?? "Changed";
}

/**
 * 生成一个版本的变更记录段，插在 CHANGELOG.md 的 `## Unreleased` 段之后（保留该段给手写的待发布说明）。
 * 标题沿用文件现有格式 `## <版本> - <日期>`。返回该段文本供 --dry 预览。
 */
function writeChangelog(version, since) {
  const { groups, count } = collectCommits(since);
  const order = ["Added", "Fixed", "Changed", "Docs", "Reverted"];
  const lines = [`## ${version} - ${today()}`, ""];
  if (!since)
    lines.push(
      "> No previous release tag was found; this section lists the whole history. Review before publishing.",
      "",
    );
  if (!count) lines.push("- No new commits since the previous release (republish).", "");
  for (const group of order) {
    const items = groups.get(group);
    if (!items) continue;
    lines.push(`### ${group}`, "");
    for (const item of items)
      lines.push(`- ${item.scope ? `**${item.scope}**: ` : ""}${item.subject} (${item.hash})`);
    lines.push("");
  }
  const section = lines.join("\n");
  const path = join(root, "CHANGELOG.md");
  const existing = existsSync(path)
    ? readFileSync(path, "utf8")
    : "# Changelog\n\n## Unreleased\n\n";
  // 正则 `/^## Unreleased\s*\n/m`：找到 Unreleased 标题行（m 让 ^ 匹配行首），新段插在它后面；没有这个标题就插在第一个 `## ` 之前
  const anchor = /^## Unreleased\s*\n/m.exec(existing);
  const at = anchor ? anchor.index + anchor[0].length : existing.search(/^## /m);
  const updated =
    at >= 0
      ? existing.slice(0, at) + "\n" + section + existing.slice(at)
      : existing + "\n" + section;
  writeFileSync(path, updated.replace(/\n{3,}/g, "\n\n"));
  // 生成的 Markdown 要过 pnpm verify 里的 format:check
  run("pnpm", ["exec", "prettier", "--write", "--log-level", "warn", "CHANGELOG.md"]);
  return section;
}

// ---------- 主流程 ----------

function snapshotManagedFiles() {
  return MANAGED_FILES.map((file) => {
    const path = join(root, file);
    return { path, content: existsSync(path) ? readFileSync(path, "utf8") : null };
  });
}

function restoreManagedFiles(snapshot) {
  for (const { path, content } of snapshot) if (content !== null) writeFileSync(path, content);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.dry ? "演练（--dry）" : "正式发布";
  const registry = LOCAL_REGISTRY;

  step(`1/6 守卫 · ${mode}`);
  // 工作区里除受管文件外不能有改动。`--porcelain` 每行形如 ` M path` / `?? path`，前 3 个字符是状态。
  const dirty = output("git", ["status", "--porcelain"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((file) => !MANAGED_FILES.includes(file));
  if (dirty.length) fail(`工作区有未提交改动，先提交或还原：\n  ${dirty.join("\n  ")}`);
  try {
    output("npm", ["ping", `--registry=${registry}`]);
  } catch {
    fail(`连不上 ${registry}。Verdaccio 没启动？`);
  }
  const localVersion = JSON.parse(
    readFileSync(join(root, "packages/core/package.json"), "utf8"),
  ).version;
  console.log(`本地版本 ${localVersion}，私服 ${registry}`);

  step("2/6 算版本");
  const published = new Map(PACKAGES.map((name) => [name, publishedVersions(name, registry)]));
  const allPublished = [...published.values()].flat();
  const highest = allPublished.length
    ? allPublished.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
    : null;
  let target;
  let reason;
  if (options.set) {
    target = options.set;
    reason = "--set 指定";
    if (highest && compareVersions(target, highest) <= 0)
      fail(`--set ${target} 不高于私服已有的最高版本 ${highest}`);
  } else if (highest && compareVersions(localVersion, highest) > 0) {
    target = localVersion;
    reason = `本地 ${localVersion} 高于私服最高 ${highest}，判断为上次发布未完成，复用`;
  } else {
    const base = highest ?? localVersion;
    const level = options.bump ?? (parseVersion(base).prerelease.length ? "pre" : "patch");
    target = bump(base, level);
    reason = `私服最高 ${highest ?? "（无）"} 按 ${level} 递增`;
  }
  const alreadyPublished = PACKAGES.filter((name) => published.get(name).includes(target));
  if (alreadyPublished.length === PACKAGES.length)
    fail(`${target} 六个包都已在私服上，没有可发布的内容`);
  if (alreadyPublished.length)
    console.log(
      `ℹ️  已发布的包：${alreadyPublished.join("、")}。publish-packages 会对它们报错，按提示用 --from <包名> 续发`,
    );
  console.log(`目标版本 ${target}（${reason}）`);

  const snapshot = snapshotManagedFiles();
  if (options.dry) cleanupOnFailure = () => restoreManagedFiles(snapshot);
  step(`3/6 改版本号 → ${target}`);
  run("pnpm", ["release:version", target]);

  step("4/6 变更记录");
  const since = previousReleaseCommit(localVersion);
  console.log(since ? `统计 ${since} 之后的提交` : "没有找到上一次发布的提交，统计全部历史");
  console.log(writeChangelog(target, since));

  step(`5/6 pnpm verify + 发布到 ${registry}${options.dry ? "（--dry-run）" : ""}`);
  run("pnpm", ["verify"]);
  run("pnpm", [
    "exec",
    "tsx",
    "scripts/publish-packages.ts",
    "--target",
    "local",
    options.dry ? "--dry-run" : "--confirm",
  ]);

  if (options.dry) {
    cleanupOnFailure = null;
    restoreManagedFiles(snapshot);
    console.log(
      `\n✅ 演练通过：${localVersion} → ${target} 可以发布。受管文件已还原，正式发布去掉 --dry 再跑一次。`,
    );
    return;
  }

  step("6/6 提交并打 tag");
  run("git", ["add", ...MANAGED_FILES]);
  run("git", ["commit", "-m", `chore(release): ${target}`]);
  run("git", ["tag", `v${target}`]);
  console.log(
    `\n✅ 已发布 xapiforge ${target} 到本机私服，提交并打 tag v${target}（未 push，远程由你决定）。`,
  );
  console.log("下一步：接入工程 `pnpm deps:upgrade xapiforge` 升级。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { parseVersion, compareVersions, bump, parseSubject, groupName };
