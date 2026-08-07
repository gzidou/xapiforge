import type { GenapiHooks } from "./index.js";
import { collectRuntimeEnumDefinitions, prepareRuntimeEnumDocument } from "./runtime-enum-model.js";
import { renderRuntimeEnumDefinition } from "./runtime-enum-render.js";
import type { RuntimeEnumHooksOptions, RuntimeEnumMetadata } from "./runtime-enum-types.js";

export type {
  RuntimeEnumAppendValue,
  RuntimeEnumExtensionValue,
  RuntimeEnumExportDescriptor,
  RuntimeEnumHooksOptions,
  RuntimeEnumMetadata,
} from "./runtime-enum-types.js";

function snapshotMetadata(
  metadata: Readonly<Record<string, RuntimeEnumMetadata>>,
): Readonly<Record<string, RuntimeEnumMetadata>> {
  try {
    return structuredClone(metadata);
  } catch (cause) {
    throw new TypeError("[genapi] runtime enum metadata 必须只包含可克隆的 JSON 数据", { cause });
  }
}

/**
 * 创建显式启用的 runtime enum hooks。
 *
 * transformSwagger 把 override/append 合并进标准 enum 数组；transformTypes 随后只读取
 * ctx.normalizedDocument 和创建 hook 时快照的 metadata，不重新读取原 Swagger。
 */
export function createRuntimeEnumHooks(options: RuntimeEnumHooksOptions = {}): GenapiHooks {
  const metadata = snapshotMetadata(options.metadata ?? {});
  return {
    async transformSwagger(swagger, ctx) {
      const preprocessed = options.preprocessSwagger
        ? await options.preprocessSwagger(swagger, ctx)
        : swagger;
      if (preprocessed === undefined || preprocessed === null) {
        throw new Error(
          `[genapi] runtime enum ${ctx.projectId}/${ctx.serviceName}: preprocessSwagger 返回空值`,
        );
      }
      const document = structuredClone(preprocessed);
      ctx.runtimeEnumExports = prepareRuntimeEnumDocument(document, metadata, ctx);
      return document;
    },
    transformTypes(typesContent, ctx) {
      if (ctx.normalizedDocument === undefined) {
        return Promise.reject(
          new Error(
            `[genapi] runtime enum ${ctx.projectId}/${ctx.serviceName}: transformTypes 缺少 normalizedDocument`,
          ),
        );
      }
      const definitions = collectRuntimeEnumDefinitions(ctx.normalizedDocument, metadata, ctx);
      if (definitions.length === 0) return Promise.resolve(typesContent);
      const prefix = typesContent.endsWith("\n") ? typesContent : `${typesContent}\n`;
      return Promise.resolve(
        `${prefix}\n${definitions.map(renderRuntimeEnumDefinition).join("\n\n")}\n`,
      );
    },
  };
}
