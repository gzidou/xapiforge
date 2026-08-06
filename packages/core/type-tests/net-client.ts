/**
 * NetClient 编译期契约：默认 data 只有 2xx；配置 validateStatus 后才增加 error body。
 * 本文件不运行，只由 `pnpm --filter @xapiforge/core typecheck` 编译。
 */

import { createNet } from "../src/index.js";
import type { AuthService } from "../src/index.js";

interface TestPaths {
  "/tasks/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: { id: string };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        200: {
          content: {
            "application/json": { id: string; name: string };
          };
        };
        404: {
          content: {
            "application/json": { message: string };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}

declare const authService: AuthService;

async function verifyDefaultContract(): Promise<void> {
  const api = createNet<TestPaths>({ baseURL: "https://example.invalid", authService });
  const { data, response } = await api.GET("/tasks/{id}", {
    params: { path: { id: "task-1" } },
  });

  const id: string = data.id;
  const status: number = response.status;
  void id;
  void status;

  // @ts-expect-error 默认 validateStatus 下，404 body 不应污染成功 data。
  void data.message;
}

async function verifyRequestValidatorContract(): Promise<void> {
  const api = createNet<TestPaths>({ baseURL: "https://example.invalid", authService });
  const { data } = await api.GET("/tasks/{id}", {
    params: { path: { id: "task-1" } },
    validateStatus: (response) => response.ok || response.status === 404,
  });

  const accepted: { id: string; name: string } | { message: string } = data;
  void accepted;
}

async function verifyGlobalValidatorContract(): Promise<void> {
  const api = createNet<TestPaths>({
    baseURL: "https://example.invalid",
    authService,
    validateStatus: (response) => response.ok || response.status === 404,
  });
  const { data } = await api.GET("/tasks/{id}", {
    params: { path: { id: "task-1" } },
  });

  const accepted: { id: string; name: string } | { message: string } = data;
  void accepted;
}

void verifyDefaultContract;
void verifyRequestValidatorContract;
void verifyGlobalValidatorContract;
