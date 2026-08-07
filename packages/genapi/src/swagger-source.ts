import { isAbsolute, join, resolve } from "node:path";

/** 本地 OpenAPI 文件；相对路径以 xapiforge.config 所在工作目录为基准。 */
export interface SwaggerFileSource {
  file: string;
  url?: never;
}

/** 完整 HTTP(S) OpenAPI 下载地址。 */
export interface SwaggerUrlSource {
  url: string;
  file?: never;
}

/** 同一个 `source` 字段明确区分本地文件与远程 URL，不根据字符串形态猜测。 */
export type SwaggerSource = SwaggerFileSource | SwaggerUrlSource;

export interface SwaggerSourceService {
  name: string;
  source: SwaggerSource;
}

export function isSwaggerFileSource(source: SwaggerSource): source is SwaggerFileSource {
  return typeof source.file === "string";
}

export function isSwaggerUrlSource(source: SwaggerSource): source is SwaggerUrlSource {
  return typeof source.url === "string";
}

const SENSITIVE_QUERY_KEY =
  /(?:^|[-_])(?:api[-_]?key|auth(?:orization)?|credential|password|secret|sig(?:nature)?|token)(?:$|[-_])/i;

/** 请求仍使用原 URL；日志只遮盖常见凭证型 query 参数。 */
export function formatSwaggerUrlForLog(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, "***");
  }
  return parsed.toString();
}

/**
 * 解析生成阶段实际读取的文件。
 *
 * URL source 读取标准下载缓存；file source 直接读取配置指定文件。
 * source 位置不参与 service/type 身份。
 */
export function resolveSwaggerInputPath(options: {
  configDirectory: string;
  swaggerRoot: string;
  projectId: string;
  service: SwaggerSourceService;
}): string {
  const { configDirectory, swaggerRoot, projectId, service } = options;
  if (isSwaggerFileSource(service.source)) {
    return isAbsolute(service.source.file)
      ? service.source.file
      : resolve(configDirectory, service.source.file);
  }
  return join(swaggerRoot, projectId, `${service.name}.json`);
}
