/**
 * createNet 的 data-or-throw 类型契约。
 *
 * openapi-fetch 原生方法返回 `{ data } | { error }`。createNet 在运行时把不可接受的
 * HTTP 状态转换成 ApiError，并把显式接受的非 2xx body 放进 data，因此这里必须同步
 * 改写方法返回类型，不能只在运行时改变行为。
 *
 * 类型规则：
 *   - 默认 validateStatus（response.ok）：data 只包含 OpenAPI 2xx 响应类型。
 *   - client 或单次请求提供 validateStatus：调用者可能接受非 2xx，data 保守地增加
 *     OpenAPI error response 类型。调用者应结合 response.status 做领域映射。
 */

import type {
  Client as OpenapiClient,
  ClientPathsWithMethod,
  FetchResponse,
  MaybeOptionalInit,
} from "openapi-fetch";
import type { HttpMethod, MediaType, RequiredKeysOf } from "openapi-typescript-helpers";
import type { NetRequestOptions, ValidateStatus } from "./types.js";

/** createNet 成功分支；失败不会 resolve。 */
export interface NetResponse<TData> {
  data: TData;
  /** 原始响应。body 可能已解析，但 status/url/headers 仍可读取。 */
  response: Response;
}

type InitParam<Init> =
  RequiredKeysOf<Init> extends never
    ? [(Init & { [key: string]: unknown })?]
    : [Init & { [key: string]: unknown }];

type OperationAt<
  Paths extends object,
  Path extends keyof Paths,
  Method extends HttpMethod,
> = Paths[Path] extends { [Key in Method]: infer Operation } ? Operation : never;

type RawOperationResponse<
  Paths extends object,
  Method extends HttpMethod,
  Path extends ClientPathsWithMethod<OpenapiClient<Paths, Media>, Method>,
  Init,
  Media extends MediaType,
> = FetchResponse<OperationAt<Paths, Path, Method> & Record<string | number, unknown>, Init, Media>;

type SuccessData<Result> = Result extends { data: infer Data } ? Data : never;
type ErrorData<Result> = Result extends { error: infer ErrorBody } ? ErrorBody : never;

type HasCustomStatus<
  Init,
  ClientHasCustomStatus extends boolean,
> = ClientHasCustomStatus extends true
  ? true
  : Init extends { validateStatus: ValidateStatus }
    ? true
    : false;

type NetData<Result, IncludeErrorData extends boolean> =
  SuccessData<Result> | (IncludeErrorData extends true ? ErrorData<Result> : never);

type NetClientMethod<
  Paths extends object,
  Method extends HttpMethod,
  Media extends MediaType,
  ClientHasCustomStatus extends boolean,
> = <
  Path extends ClientPathsWithMethod<OpenapiClient<Paths, Media>, Method>,
  Init extends MaybeOptionalInit<Paths[Path], Extract<Method, keyof Paths[Path]>> &
    NetRequestOptions,
>(
  url: Path,
  ...init: InitParam<Init>
) => Promise<
  NetResponse<
    NetData<
      RawOperationResponse<Paths, Method, Path, Init, Media>,
      HasCustomStatus<Init, ClientHasCustomStatus>
    >
  >
>;

type NetClientRequestMethod<
  Paths extends object,
  Media extends MediaType,
  ClientHasCustomStatus extends boolean,
> = <
  Method extends HttpMethod,
  Path extends ClientPathsWithMethod<OpenapiClient<Paths, Media>, Method>,
  Init extends MaybeOptionalInit<Paths[Path], Extract<Method, keyof Paths[Path]>> &
    NetRequestOptions,
>(
  method: Method,
  url: Path,
  ...init: InitParam<Init>
) => Promise<
  NetResponse<
    NetData<
      RawOperationResponse<Paths, Method, Path, Init, Media>,
      HasCustomStatus<Init, ClientHasCustomStatus>
    >
  >
>;

type ReplacedMethod =
  "request" | "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE";

/**
 * 与 openapi-fetch Client 相同的强类型 path/body/params 推导，但请求只 resolve NetResponse。
 * use/eject 保留原 middleware API。
 */
export type NetClient<
  Paths extends object,
  ClientHasCustomStatus extends boolean = false,
  Media extends MediaType = MediaType,
> = Omit<OpenapiClient<Paths, Media>, ReplacedMethod> & {
  request: NetClientRequestMethod<Paths, Media, ClientHasCustomStatus>;
  GET: NetClientMethod<Paths, "get", Media, ClientHasCustomStatus>;
  PUT: NetClientMethod<Paths, "put", Media, ClientHasCustomStatus>;
  POST: NetClientMethod<Paths, "post", Media, ClientHasCustomStatus>;
  DELETE: NetClientMethod<Paths, "delete", Media, ClientHasCustomStatus>;
  OPTIONS: NetClientMethod<Paths, "options", Media, ClientHasCustomStatus>;
  HEAD: NetClientMethod<Paths, "head", Media, ClientHasCustomStatus>;
  PATCH: NetClientMethod<Paths, "patch", Media, ClientHasCustomStatus>;
  TRACE: NetClientMethod<Paths, "trace", Media, ClientHasCustomStatus>;
};
