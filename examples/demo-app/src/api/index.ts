/**
 * 项目 API 入口（业务侧统一 import 路径）
 *
 *   import { useApi } from "@/api";
 *   const api = useApi();                         // 默认 client (Demo)
 *   const ticket = useApi<TTicketPaths>('ticket'); // 命名 client (第三方)
 *
 * main.ts 入口：
 *   setup({ baseURL, tokenStore, ... });                      // net 全局
 *   initApi('demo', { baseURL: BASE_URL, middleware: [createNetMiddleware()] });
 *   initApi('ticket', {
 *     baseURL: 'https://ticket.3rd.com',
 *     middleware: [ticketOAuthMw()],          // 第三方自己的 OAuth
 *     // （不需要 setup() 的 tokenStore —— middleware 自己处理认证）
 *   });
 */

export { initApi, useApi, listClients, _resetApiForTests } from "./init.js";
