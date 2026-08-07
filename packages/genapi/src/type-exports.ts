import { lexicalCompare, pascalCaseConfigId, safeCommentText, safeTypeAlias } from "./naming.js";

/** schema full name 前缀分组；所在层级由导出策略决定。 */
export interface NamespaceRule {
  /** 仅匹配指定 service；省略表示 project 内每个 service。 */
  service?: string;
  match: string;
  namespace: string;
}

/** 给确定的 service/full schema identity 配置稳定公开名称。 */
export interface SchemaAliasRule {
  service: string;
  schema: string;
  exportAs: string;
  /** service-namespace 下为二级 namespace；flat-strict 下为顶层 namespace。 */
  namespace?: string;
}

/**
 * service-namespace：默认策略，生成 `<Service>Schemas` 稳定外层 namespace。
 * flat-strict：生成 project 顶层便利 alias/namespace，任何同作用域碰撞立即失败。
 * canonical-only：只生成 SchemasByService / SchemaOf，不生成便利名称。
 */
export type TypeExportStrategy = "canonical-only" | "flat-strict" | "service-namespace";

export interface ProjectTypeExportConfig {
  /** 默认 service-namespace。 */
  strategy?: TypeExportStrategy;
  namespaces?: NamespaceRule[];
  aliases?: SchemaAliasRule[];
}

export interface ApiTypesServiceModel {
  name: string;
  schemas: Readonly<Record<string, unknown>>;
}

export interface RenderApiTypesOptions {
  projectId: string;
  projectDisplay: string;
  services: readonly ApiTypesServiceModel[];
  typeExports?: ProjectTypeExportConfig;
}

interface SchemaRef {
  service: string;
  full: string;
}

interface ExportEntry extends SchemaRef {
  alias: string;
  namespace: string | null;
}

function shortAlias(full: string): string {
  // .NET 泛型 metadata schema 没有稳定合法的短名；仍可通过 SchemaOf 访问。
  if (full.includes("`")) return "";
  const parts = full.split(/[.[\], ]+/).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (/^[A-Za-z_$]/.test(part)) return safeTypeAlias(part);
  }
  return "";
}

/**
 * 匹配不依赖配置数组顺序：service 专属规则优先，再取最长前缀。
 * 这保证仅重新排列配置不会移动既有类型。
 */
function matchNamespace(
  service: string,
  full: string,
  rules: readonly NamespaceRule[],
): string | null {
  const matches = rules
    .filter(
      (rule) =>
        (rule.service === undefined || rule.service === service) && full.startsWith(rule.match),
    )
    .sort((left, right) => {
      const servicePriority =
        Number(right.service !== undefined) - Number(left.service !== undefined);
      if (servicePriority !== 0) return servicePriority;
      const prefixPriority = right.match.length - left.match.length;
      return prefixPriority !== 0
        ? prefixPriority
        : lexicalCompare(left.namespace, right.namespace);
    });
  return matches[0]?.namespace ?? null;
}

function renderCanonicalTypes(lines: string[], services: readonly ApiTypesServiceModel[]): void {
  for (const service of services) {
    lines.push(
      `import type { components as ${pascalCaseConfigId(service.name)}Components } from "./types/${service.name}.js";`,
    );
  }
  lines.push("");
  lines.push("export interface SchemasByService {");
  for (const service of services) {
    lines.push(
      `  ${JSON.stringify(service.name)}: ${pascalCaseConfigId(service.name)}Components["schemas"];`,
    );
  }
  lines.push("}");
  lines.push("");
  lines.push("export type ServiceName = keyof SchemasByService;");
  lines.push("export type SchemaOf<");
  lines.push("  Service extends ServiceName,");
  lines.push("  Name extends keyof SchemasByService[Service],");
  lines.push("> = SchemasByService[Service][Name];");
  lines.push("");
}

type ConvenienceExportStrategy = Exclude<TypeExportStrategy, "canonical-only">;

function collectConvenienceExports(options: {
  collected: readonly SchemaRef[];
  services: readonly ApiTypesServiceModel[];
  typeExports: ProjectTypeExportConfig | undefined;
  strategy: ConvenienceExportStrategy;
}): ExportEntry[] {
  const explicitAliases = new Map(
    (options.typeExports?.aliases ?? []).map((rule) => [`${rule.service}\0${rule.schema}`, rule]),
  );
  for (const rule of options.typeExports?.aliases ?? []) {
    const service = options.services.find((candidate) => candidate.name === rule.service);
    if (!service) {
      throw new Error(`[genapi] 显式 alias 指向不存在的 service：${rule.service}`);
    }
    if (!Object.prototype.hasOwnProperty.call(service.schemas, rule.schema)) {
      throw new Error(
        `[genapi] 显式 alias 指向不存在的 schema：${rule.service}/${rule.schema} → ${rule.exportAs}`,
      );
    }
  }

  const entries: ExportEntry[] = [];
  const targets = new Map<string, ExportEntry>();
  const directAliases = new Map<string, Set<string>>();
  const nestedNamespaces = new Map<string, Set<string>>();
  const reservedFlatNames = new Set([
    "SchemaOf",
    "SchemasByService",
    "ServiceName",
    ...options.services.map((service) => `${pascalCaseConfigId(service.name)}Components`),
  ]);

  for (const schema of options.collected) {
    const explicit = explicitAliases.get(`${schema.service}\0${schema.full}`);
    const alias = explicit?.exportAs ?? shortAlias(schema.full);
    if (!alias) continue;
    const namespace =
      explicit?.namespace ??
      matchNamespace(schema.service, schema.full, options.typeExports?.namespaces ?? []);
    const scope = options.strategy === "service-namespace" ? schema.service : "*";
    const target = `${scope}\0${namespace ?? ""}\0${alias}`;
    const previous = targets.get(target);
    if (previous) {
      const qualified = [
        options.strategy === "service-namespace"
          ? `${pascalCaseConfigId(schema.service)}Schemas`
          : "",
        namespace ?? "",
        alias,
      ]
        .filter(Boolean)
        .join(".");
      throw new Error(
        `[genapi] schema alias 冲突：${qualified}\n` +
          `  - ${previous.service}/${previous.full}\n` +
          `  - ${schema.service}/${schema.full}\n` +
          "生成器不会根据顺序保留、跳过或自动重命名；请配置唯一的 typeExports.aliases。",
      );
    }

    if (
      options.strategy === "flat-strict" &&
      reservedFlatNames.has(namespace === null ? alias : namespace)
    ) {
      throw new Error(
        `[genapi] flat-strict 顶层名称 "${namespace ?? alias}" 与 canonical/import 名称冲突`,
      );
    }

    const direct = directAliases.get(scope) ?? new Set<string>();
    const nested = nestedNamespaces.get(scope) ?? new Set<string>();
    const location =
      options.strategy === "service-namespace"
        ? `${pascalCaseConfigId(schema.service)}Schemas 下`
        : "flat-strict 顶层";
    if (namespace === null && nested.has(alias)) {
      throw new Error(`[genapi] ${location} alias "${alias}" 与同名 namespace 冲突`);
    }
    if (namespace !== null && direct.has(namespace)) {
      throw new Error(`[genapi] ${location} namespace "${namespace}" 与同名 alias 冲突`);
    }
    if (namespace === null) direct.add(alias);
    else nested.add(namespace);
    directAliases.set(scope, direct);
    nestedNamespaces.set(scope, nested);

    const entry = { service: schema.service, full: schema.full, alias, namespace };
    targets.set(target, entry);
    entries.push(entry);
  }
  return entries;
}

function renderFlatExports(lines: string[], entries: readonly ExportEntry[]): void {
  const direct = entries
    .filter((entry) => entry.namespace === null)
    .sort((left, right) => lexicalCompare(left.alias, right.alias));
  const namespaces = new Map<string, ExportEntry[]>();
  for (const entry of entries) {
    if (entry.namespace === null) continue;
    const group = namespaces.get(entry.namespace) ?? [];
    group.push(entry);
    namespaces.set(entry.namespace, group);
  }

  for (const namespace of [...namespaces.keys()].sort(lexicalCompare)) {
    const group = namespaces.get(namespace)!;
    group.sort((left, right) => lexicalCompare(left.alias, right.alias));
    lines.push(`/** project-level schema prefix namespace ${safeCommentText(namespace)} */`);
    lines.push(`export namespace ${namespace} {`);
    for (const entry of group) {
      lines.push(`  /** ${safeCommentText(`${entry.service}/${entry.full}`)} */`);
      lines.push(
        `  export type ${entry.alias} = SchemaOf<${JSON.stringify(entry.service)}, ${JSON.stringify(entry.full)}>;`,
      );
    }
    lines.push("}");
    lines.push("");
  }

  for (const entry of direct) {
    lines.push(`/** ${safeCommentText(`${entry.service}/${entry.full}`)} */`);
    lines.push(
      `export type ${entry.alias} = SchemaOf<${JSON.stringify(entry.service)}, ${JSON.stringify(entry.full)}>;`,
    );
  }
  if (direct.length > 0) lines.push("");
}

function renderServiceNamespaces(
  lines: string[],
  services: readonly ApiTypesServiceModel[],
  entries: readonly ExportEntry[],
): void {
  for (const service of services) {
    const serviceEntries = entries.filter((entry) => entry.service === service.name);
    const namespaceName = `${pascalCaseConfigId(service.name)}Schemas`;
    const direct = serviceEntries
      .filter((entry) => entry.namespace === null)
      .sort((left, right) => lexicalCompare(left.alias, right.alias));
    const nested = new Map<string, ExportEntry[]>();
    for (const entry of serviceEntries) {
      if (entry.namespace === null) continue;
      const group = nested.get(entry.namespace) ?? [];
      group.push(entry);
      nested.set(entry.namespace, group);
    }

    lines.push(
      `/** ${safeCommentText(service.name)} service schemas；source 位置变化不会改变此 namespace。 */`,
    );
    lines.push(`export namespace ${namespaceName} {`);
    for (const entry of direct) {
      lines.push(`  /** ${safeCommentText(entry.full)} */`);
      lines.push(
        `  export type ${entry.alias} = SchemaOf<${JSON.stringify(entry.service)}, ${JSON.stringify(entry.full)}>;`,
      );
    }
    for (const namespace of [...nested.keys()].sort(lexicalCompare)) {
      const group = nested.get(namespace)!;
      group.sort((left, right) => lexicalCompare(left.alias, right.alias));
      lines.push(`  /** schema prefix namespace ${safeCommentText(namespace)} */`);
      lines.push(`  export namespace ${namespace} {`);
      for (const entry of group) {
        lines.push(`    /** ${safeCommentText(entry.full)} */`);
        lines.push(
          `    export type ${entry.alias} = SchemaOf<${JSON.stringify(entry.service)}, ${JSON.stringify(entry.full)}>;`,
        );
      }
      lines.push("  }");
    }
    lines.push("}");
    lines.push("");
  }
}

/** 生成 canonical schema API，并按策略生成严格 flat 或 service namespace 便利导出。 */
export function renderApiTypes(options: RenderApiTypesOptions): string {
  const services = [...options.services].sort((left, right) =>
    lexicalCompare(left.name, right.name),
  );
  const strategy = options.typeExports?.strategy ?? "service-namespace";
  const collected: SchemaRef[] = services.flatMap((service) =>
    Object.keys(service.schemas)
      .sort(lexicalCompare)
      .map((full) => ({ service: service.name, full })),
  );
  const lines = [
    "/* eslint-disable */",
    "/**",
    ` * @${options.projectId}/api-types — 自动生成，别手改`,
    " *",
    ` * 项目：${safeCommentText(options.projectDisplay)}（${options.projectId}），service 数：${services.length}`,
    ` * 导出策略：${strategy}`,
    " * schema identity 固定为 service + full schema name；source 位置与配置顺序不参与命名。",
    " */",
    "",
  ];

  renderCanonicalTypes(lines, services);
  if (strategy === "canonical-only") return lines.join("\n");

  const entries = collectConvenienceExports({
    collected,
    services,
    typeExports: options.typeExports,
    strategy,
  });
  if (strategy === "flat-strict") renderFlatExports(lines, entries);
  else renderServiceNamespaces(lines, services, entries);
  return lines.join("\n");
}
