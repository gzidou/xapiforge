/**
 * 业务侧分页 unwrap 工具（per project 自己写）
 *
 * net 包不假设分页字段名（ABP / Spring / Element Plus / 国内通用 / 业务自定义
 * 等都不相同），所以每个项目自己写解包工具。
 *
 * examples/demo-app 用的就是 ABP 的 PagedResultDto<T> = { items: T[], totalCount: number }
 * 项目用 ABP 后端用 `unwrapAbpPaged<T>(raw)` 解 envelope.data 后的 paged 结构。
 *
 * 你项目（不同 shape）：
 *   unwrapSpringPaged<T>(raw)         // {content: T[], totalElements: number}
 *   unwrapElementPaged<T>(raw)        // {list: T[], total: number}
 *   unwrapExoticPaged<T>(raw)         // {records: T[], pagination: {total, current}}
 *
 * 调用链：initApi 时 unwrapResponse 解 envelope → 这里只负责 paged 字段名映射。
 *
 * 提示：env 偏离默认 envelope 时，per-call 用 net 的 createUnwrapResponseMw：
 *   await api.base.GET('/path', {
 *     middleware: [createUnwrapResponseMw(p => p.data ?? p)],
 *   });
 */

/**
 * 业务侧的"分页数据形状"——本项目定。
 * ABP PagedResultDto<T> = { items, totalCount }，本项目就把这个形状钉在 PagedList<T>。
 * 业务侧字段名（items / totalCount）就是 ABP 自己的名字——> 结构对应用类型即一致。
 */
export interface PagedList<T> {
  readonly items: ReadonlyArray<T>;
  readonly totalCount: number;
}

/**
 * ABP 后端 paged 响应解包
 *
 *   const users = unwrapAbpPaged<IdentityUserDto>(await api.base.GET("/api/identity/users", { ... }));
 *   users.items[0].userName    // 字段拼错立刻报错
 *   users.totalCount           // number（默认 0）
 *
 * 注意：`raw` 已经是 initApi 配的 unwrapResponse 解 envelope 后的 `data` 字段，
 * 不是 HTTP body 本身。
 */
export function unwrapAbpPaged<T>(raw: unknown): PagedList<T> {
  const p = (raw ?? {}) as { items?: T[] | null; totalCount?: number };
  return {
    items: p.items ?? [],
    totalCount: p.totalCount ?? 0,
  };
}

// 角色子资源 endpoint 实际返回 ABP 一样的 paged 形状（{items: [{name}], totalCount}）。
// 不写专门函数，调用方写一行：
//   const roles = unwrapAbpPaged<{name: string}>(await api.base.GET("/api/identity/users/{id}/roles", ...));
