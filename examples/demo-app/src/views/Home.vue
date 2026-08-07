<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import type {
  AppManagementDto,
  FileEntityDto,
  RoleDto,
  UserCreateDto,
  UserDto,
  UserUpdateDto,
} from "../api/gen/demo/api-types.js";
import { unwrapAbpPaged, type PagedList } from "../utils/paged.js";
import { localStorageStore } from "@xapiforge/adapter-browser";
import { useApi } from "../api/index.js";

/**
 * Demo 业务 API demo —— openapi-fetch × @xapiforge/core
 *
 * 本页只使用仓库内置离线 Swagger 已声明的 DTO、path 和参数。每次运行 genapi 后，
 * 页面仍必须通过 vue-tsc，避免示例依赖未提交的旧生成文件。
 *
 * 8 种常见调用：
 *   1. GET 列表（分页）                    → /api/identity/users
 *        返回 PagedList<UserDto>
 *   2. GET 详情（path param）               → /api/identity/users/{id}
 *        返回 UserDto
 *   3. POST 创建（JSON body）               → /api/identity/users
 *        body  UserCreateDto（创建），响应 UserDto
 *   4. PUT 更新（path + JSON body）         → /api/identity/users/{id}
 *        body  UserUpdateDto，响应 UserDto
 *   5. DELETE 删除（path）                  → /api/identity/users/{id}
 *        返回 void（按 id 记成功删除）
 *   6. GET 角色（子资源）                    → /api/identity/users/{id}/roles
 *        返回 RoleDto[]
 *   7. GET 配置 query                        → /api/infrastructure/appManagement
 *        返回 AppManagementDto
 *   8. POST file upload（multipart/form-data）→ /api/fileService/fileEntity/uploading
 *        返回 FileEntityDto
 *
 * 类型推导：
 *   import type { UserDto } from "../api/gen/demo/api-types.js";
 *   // ↑ 自动从 components.schemas 导出的 alias，字段拼错立刻报错
 *
 *   await api.base.GET("/api/identity/users/{id}", { params: { path: { id } } });
 *   //       ^ openapi-typescript 生成的 paths 类型，path 必须合法 + path param 必填
 */

// ============================================================
// openapi-fetch × net 集成：useApi() 默认 client；useApi('weather') 第三方 client
// ============================================================

const api = useApi(); // default (Demo)
const weatherApi = useApi("weather"); // 第三方 (mock 用同一 server /api/3rd/weather)

const router = useRouter();
const lastResult = ref<string>("");
const lastError = ref<string | null>(null);
const isLoading = ref(false);

// ============================================================
// 类型化的"接收返回值"台
//   - 8 个 ref 都强类型，setData 写入后 UI 直接 v-for
// ============================================================

const lastUsers = ref<PagedList<UserDto>>({ items: [], totalCount: 0 });
const lastUser = ref<UserDto | null>(null);
const lastCreatedUser = ref<UserDto | null>(null);
const lastUpdatedUser = ref<UserDto | null>(null);
const lastDeleteId = ref<string | null>(null);
const lastRoles = ref<RoleDto[]>([]);
const lastApp = ref<AppManagementDto | null>(null);
const lastUpload = ref<FileEntityDto | null>(null);

/**
 * 类型化的 safeCall：泛型 O 是 OK 数据类型，setData 接收 O 写入 typed ref。
 * 业务代码只用写"想要的 O"——openapi-fetch 推导 → setData → UI 直接用。
 */
async function safeCall<O>(
  label: string,
  fn: () => Promise<{ data: O; response: Response }>,
  setData: (data: O) => void,
): Promise<void> {
  isLoading.value = true;
  lastError.value = null;
  try {
    // createNet 的失败只会进入 catch；resolve 后 data 一定属于成功契约。
    const { data } = await fn();
    if (data !== undefined) setData(data as O);
    lastResult.value = `${label}\n${JSON.stringify(data, null, 2).slice(0, 1200)}`;
  } catch (error: unknown) {
    lastError.value = error instanceof Error ? error.message : String(error);
    lastResult.value = "";
  } finally {
    isLoading.value = false;
  }
}

// 1. GET 列表（分页）—— 接收 PagedList<UserDto>
const listFilter = reactive({
  keyword: "",
  pageIndex: 1,
  pageSize: 10,
});
async function listUsers() {
  await safeCall(
    "GET /api/identity/users（分页列表）",
    () =>
      api.base.GET("/api/identity/users", {
        params: {
          query: {
            keyword: listFilter.keyword || undefined,
            pageIndex: listFilter.pageIndex,
            pageSize: listFilter.pageSize,
          },
        },
      }),
    (data) => {
      lastUsers.value = unwrapAbpPaged<UserDto>(data);
    },
  );
}

// 2. GET 详情（path）—— UserDto
const singleId = ref("");
async function getUser() {
  if (!singleId.value) return;
  await safeCall(
    `GET /api/identity/users/{id}（id=${singleId.value}）`,
    () =>
      api.base.GET("/api/identity/users/{id}", {
        params: { path: { id: singleId.value } },
      }),
    (data) => {
      lastUser.value = data;
    },
  );
}

// 3. POST 创建 —— body: UserCreateDto，响应 UserDto
const createForm = reactive({
  userName: "",
  name: "",
  surname: "",
  email: "",
  password: "P@ssw0rd!",
  phoneNumber: "",
});
async function createUser() {
  const body: UserCreateDto = {
    userName: createForm.userName,
    name: createForm.name || undefined,
    surname: createForm.surname || undefined,
    email: createForm.email,
    password: createForm.password,
    phoneNumber: createForm.phoneNumber || undefined,
  };
  await safeCall(
    "POST /api/identity/users（创建）",
    () => api.base.POST("/api/identity/users", { body }),
    (data) => {
      lastCreatedUser.value = data;
    },
  );
}

// 4. PUT 更新 —— body: UserUpdateDto，响应 UserDto
const updateForm = reactive({
  id: "",
  name: "",
  surname: "",
  phoneNumber: "",
});
async function updateUser() {
  if (!updateForm.id) return;
  const body: UserUpdateDto = {
    name: updateForm.name || undefined,
    surname: updateForm.surname || undefined,
    phoneNumber: updateForm.phoneNumber || undefined,
  };
  await safeCall(
    `PUT /api/identity/users/{id}（id=${updateForm.id}）`,
    () =>
      api.base.PUT("/api/identity/users/{id}", {
        params: { path: { id: updateForm.id } },
        body,
      }),
    (data) => {
      lastUpdatedUser.value = data;
    },
  );
}

// 5. DELETE 删除 —— data 为空，记 id
const deleteId = ref("");
async function deleteUser() {
  if (!deleteId.value) return;
  await safeCall(
    `DELETE /api/identity/users/{id}（id=${deleteId.value}）`,
    () =>
      api.base.DELETE("/api/identity/users/{id}", {
        params: { path: { id: deleteId.value } },
      }),
    () => {
      lastDeleteId.value = deleteId.value;
    },
  );
}

// 6. GET 角色子资源 —— RoleDto[]
const rolesUserId = ref("");
async function getUserRoles() {
  if (!rolesUserId.value) return;
  await safeCall(
    `GET /api/identity/users/{id}/roles（id=${rolesUserId.value}）`,
    () =>
      api.base.GET("/api/identity/users/{id}/roles", {
        params: { path: { id: rolesUserId.value } },
      }),
    (data) => {
      lastRoles.value = data;
    },
  );
}

// 7. GET 配置 query —— AppManagementDto
const complexQuery = reactive({
  module: "core",
  enabled: true,
});
async function queryComplex() {
  await safeCall(
    "GET /api/infrastructure/appManagement（复杂 query）",
    () =>
      api.base.GET("/api/infrastructure/appManagement", {
        params: {
          query: {
            module: complexQuery.module || undefined,
            enabled: complexQuery.enabled,
          },
        },
      }),
    (data) => {
      lastApp.value = data;
    },
  );
}

// 8. POST file upload —— FileEntityDto
const uploadForm = reactive({
  files: [] as File[],
});
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  uploadForm.files = Array.from(input.files ?? []);
}
async function uploadFile() {
  if (uploadForm.files.length === 0) return;
  const fd = new FormData();
  const file = uploadForm.files[0];
  if (!file) return;
  fd.append("file", file, file.name);
  isLoading.value = true;
  lastError.value = null;
  try {
    // upload 是无 schema 辅助入口，直接返回解析后的数据；失败仍统一抛 ApiError。
    const data = await api.upload<FileEntityDto>("/api/fileService/fileEntity/uploading", fd);
    lastUpload.value = data;
    lastResult.value = `POST /api/fileService/fileEntity/uploading（multipart）\n${JSON.stringify(data, null, 2)}`;
  } catch (error: unknown) {
    lastError.value = error instanceof Error ? error.message : String(error);
    lastResult.value = "";
  } finally {
    isLoading.value = false;
  }
}

const tokenStore = localStorageStore("app_token");
function logout() {
  tokenStore.clear();
  localStorage.removeItem("app_refresh_token");
  void router.push("/login");
}

// 9. 第三方 API —— 演示 useApi('weather') 命名 client + 不同 envelope 解包
//
//   第三方 envelope：{ ok: true, data: {...} } / { ok: false, err: { code, msg } }
//   业务 envelope：  { code: 0, data: {...}, message: ... }
//
// mock-server 端 /api/3rd/weather 返回 { ok, data: { city, tempC, humidity, wind } }
interface WeatherDto {
  city: string;
  tempC: number;
  humidity: number;
  wind: string;
  observedAt: string;
}
const weatherCity = ref("北京");
interface ExoticDto {
  id: string;
  items: string[];
  observedAt: string;
}
const lastExotic = ref<ExoticDto | null>(null);
async function queryExotic() {
  // /api/3rd/exotic 在 weather client 上 —— baseURL 是 "/api/3rd"。
  // 用 client.request<ExoticDto>(...) 一行调：
  //   - method GET（默认）
  //   - unwrap 是业务侧 1 行 envelope 处理（覆盖默认）
  // 之前需要 cast `as unknown as { GET: ... }` 是因为 api.base 类型是 Demo schema
  // 强类型 —— request 直接 raw fetch 不走 schema，0 cast 搞定第三方 API。
  const env = await weatherApi.request<{ data?: ExoticDto }>("/exotic", {
    unwrap: (payload) => payload as { data?: ExoticDto },
  });
  // request 自己 unwrap 后返的就是 env；但我们这里 unwrap 返回 {data}，
  // 所以再 unwrap 一次拿 ExoticDto
  lastExotic.value = env.data ?? null;
}

// weather 第三方 envelope 形状：{ ok, data }
// v0.2：用 request + unwrap 解包第三方 envelope（库不再提供 raw()）
interface WeatherEnvelope {
  ok?: boolean;
  data?: WeatherDto;
}
const lastWeather = ref<WeatherDto | null>(null);
async function queryWeather() {
  // request 返回 Promise<T>，用 unwrap 解 envelope。
  // 第三方 API 不走 safeCall 通用路径，直接自己 try/catch。
  isLoading.value = true;
  lastError.value = null;
  try {
    const env = await weatherApi.request<WeatherEnvelope>(
      `/weather?city=${encodeURIComponent(weatherCity.value)}`,
      { unwrap: (p) => p as WeatherEnvelope },
    );
    lastWeather.value = env?.data ?? null;
    lastResult.value =
      `GET /api/3rd/weather (第三方 client = weather)\n` +
      JSON.stringify(env, null, 2).slice(0, 1200);
  } catch (e) {
    lastError.value = (e as Error).message;
    lastResult.value = "";
  } finally {
    isLoading.value = false;
  }
}

const tabs = [
  "list",
  "get",
  "create",
  "update",
  "delete",
  "roles",
  "complex",
  "upload",
  "weather",
  "exotic",
] as const;
const activeTab = ref<(typeof tabs)[number]>("list");

onMounted(() => {
  listUsers();
});
</script>

<template>
  <div class="home">
    <header>
      <h1>Demo 业务 API demo</h1>
      <div class="nav">
        <RouterLink to="/scenarios">场景演示</RouterLink>
        <button class="logout" @click="logout">退出</button>
      </div>
    </header>

    <p class="hint">
      生成产物 <code>src/api/gen/demo/</code>。<br />
      入口：<code>api.&lt;service&gt;.GET/POST/PUT/DELETE(path, &#123; params: ... &#125;)</code> ——
      所有 method/path/参数全强类型。<br />
      接收返回值使用当前离线 Swagger 生成的 <code>UserDto</code>、<code>RoleDto</code> 和
      <code>AppManagementDto</code>；重新生成后由 vue-tsc 校验页面与契约是否同步。
    </p>

    <nav class="tabs">
      <button
        v-for="t in tabs"
        :key="t"
        :class="{ active: activeTab === t }"
        @click="activeTab = t"
      >
        {{ t }}
      </button>
    </nav>

    <section v-show="activeTab === 'list'">
      <h2>1. GET /api/identity/users（分页列表） — {{ lastUsers.totalCount }} 条</h2>
      <div class="form">
        <label>Keyword <input v-model="listFilter.keyword" placeholder="模糊过滤" /></label>
        <label>PageIndex <input v-model.number="listFilter.pageIndex" type="number" /></label>
        <label>PageSize <input v-model.number="listFilter.pageSize" type="number" /></label>
        <button :disabled="isLoading" @click="listUsers">查询</button>
      </div>
      <table v-if="lastUsers.items.length > 0" class="rows">
        <thead>
          <tr>
            <th>id</th>
            <th>userName</th>
            <th>name</th>
            <th>email</th>
            <th>phone</th>
            <th>active</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in lastUsers.items" :key="u.id">
            <td>{{ u.id }}</td>
            <td>{{ u.userName }}</td>
            <td>{{ u.name }}</td>
            <td>{{ u.email }}</td>
            <td>{{ u.phoneNumber ?? "-" }}</td>
            <td>{{ u.isActive ? "✅" : "❌" }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">（点击"查询"加载）</p>
    </section>

    <section v-show="activeTab === 'get'">
      <h2>2. GET /api/identity/users/{id}（path param）</h2>
      <div class="form">
        <label>User ID <input v-model="singleId" placeholder="uuid" /></label>
        <button :disabled="isLoading" @click="getUser">查询</button>
      </div>
      <pre v-if="lastUser" class="kv"><span>id:</span> {{ lastUser.id }}
<span>userName:</span> {{ lastUser.userName }}
<span>name:</span> {{ lastUser.name }}
<span>email:</span> {{ lastUser.email }}
<span>phoneNumber:</span> {{ lastUser.phoneNumber }}
<span>isActive:</span> {{ lastUser.isActive }}
<span>creationTime:</span> {{ lastUser.creationTime }}</pre>
      <p v-else class="empty">（输入 id 后查询）</p>
    </section>

    <section v-show="activeTab === 'create'">
      <h2>3. POST /api/identity/users（创建用户）</h2>
      <div class="form">
        <label>userName* <input v-model="createForm.userName" /></label>
        <label>name <input v-model="createForm.name" /></label>
        <label>surname <input v-model="createForm.surname" /></label>
        <label>email* <input v-model="createForm.email" type="email" /></label>
        <label>phoneNumber <input v-model="createForm.phoneNumber" /></label>
        <label>password <input v-model="createForm.password" type="password" /></label>
        <button :disabled="isLoading" @click="createUser">创建</button>
      </div>
      <p v-if="lastCreatedUser" class="ok">
        已创建：<code>{{ lastCreatedUser.userName }}</code
        >（id= <code>{{ lastCreatedUser.id }}</code
        >，创建时间 <code>{{ lastCreatedUser.creationTime }}</code
        >）
      </p>
    </section>

    <section v-show="activeTab === 'update'">
      <h2>4. PUT /api/identity/users/{id}（更新）</h2>
      <div class="form">
        <label>User ID* <input v-model="updateForm.id" /></label>
        <label>name <input v-model="updateForm.name" /></label>
        <label>surname <input v-model="updateForm.surname" /></label>
        <label>phoneNumber <input v-model="updateForm.phoneNumber" /></label>
        <button :disabled="isLoading" @click="updateUser">更新</button>
      </div>
      <p v-if="lastUpdatedUser" class="ok">
        已更新：<code>{{ lastUpdatedUser.userName }}</code
        >（phone= <code>{{ lastUpdatedUser.phoneNumber ?? "-" }}</code
        >）
      </p>
    </section>

    <section v-show="activeTab === 'delete'">
      <h2>5. DELETE /api/identity/users/{id}</h2>
      <div class="form">
        <label>User ID* <input v-model="deleteId" /></label>
        <button :disabled="isLoading" @click="deleteUser">删除</button>
      </div>
      <p v-if="lastDeleteId" class="ok">
        已删除 id=<code>{{ lastDeleteId }}</code>
      </p>
    </section>

    <section v-show="activeTab === 'roles'">
      <h2>6. GET /api/identity/users/{id}/roles（子资源） — {{ lastRoles.length }} 个</h2>
      <div class="form">
        <label>User ID <input v-model="rolesUserId" /></label>
        <button :disabled="isLoading" @click="getUserRoles">查询</button>
      </div>
      <ul v-if="lastRoles.length > 0">
        <li v-for="r in lastRoles" :key="r.id ?? r.name">{{ r.name }}</li>
      </ul>
      <p v-else class="empty">（输入 id 后查询）</p>
    </section>

    <section v-show="activeTab === 'complex'">
      <h2>7. GET /api/infrastructure/appManagement（配置 query）</h2>
      <div class="form">
        <label>Module <input v-model="complexQuery.module" /></label>
        <label>Enabled <input v-model="complexQuery.enabled" type="checkbox" /></label>
        <button :disabled="isLoading" @click="queryComplex">查询</button>
      </div>
      <pre v-if="lastApp" class="kv"><span>version:</span> {{ lastApp.version }}
<span>modules:</span> {{ lastApp.modules?.join(", ") || "-" }}</pre>
      <p v-else class="empty">（点击"查询"加载）</p>
    </section>

    <section v-show="activeTab === 'upload'">
      <h2>8. POST /api/fileService/fileEntity/uploading（multipart）</h2>
      <div class="form">
        <label>File <input type="file" @change="onFileChange" /></label>
        <button :disabled="isLoading || uploadForm.files.length === 0" @click="uploadFile">
          上传
        </button>
      </div>
      <pre v-if="lastUpload" class="kv"><span>id:</span> {{ lastUpload.id }}
<span>name:</span> {{ lastUpload.name }}
<span>size:</span> {{ lastUpload.size ?? "-" }}
<span>contentType:</span> {{ lastUpload.contentType ?? "-" }}</pre>
    </section>
    <section v-show="activeTab === 'exotic'">
      <h2>10. GET /api/3rd/exotic（偏离 envelope —— request unwrap 参数）</h2>
      <p class="hint">
        服务器响应 <code>&#123; code: 200, data: &#123;...&#125;, msg: "ok" &#125;</code> （不是
        Demo ABP envelope）。<code
          >request&lt;T&gt;('/exotic', &#123; unwrap: p => p.data &#125;)</code
        >
        一行调用解决——<strong>通用方案：每个第三方 API endpoint 都能传 unwrap</strong>。<br />
        不传 unwrap = 裸返（introspect、metrics 这种 pure data）；传了 = envelope 解包。
      </p>
      <div class="form">
        <button :disabled="isLoading" @click="queryExotic">查询</button>
      </div>
      <pre v-if="lastExotic" class="kv"><span>id:</span> {{ lastExotic.id }}
<span>items:</span> {{ lastExotic.items.join(", ") }}
<span>observedAt:</span> {{ lastExotic.observedAt }}</pre>
      <p v-else class="empty">（点查询）</p>
    </section>

    <section v-show="activeTab === 'weather'">
      <h2>9. GET /api/3rd/weather（第三方 API —— 命名 client 'weather'）</h2>
      <p class="hint">
        baseURL = <code>http://localhost:8787/api/3rd</code> · envelope 是
        <code>&#123; ok, data &#125;</code>（不是 Demo 的 ABP envelope）。
      </p>
      <div class="form">
        <label>城市 <input v-model="weatherCity" /></label>
        <button :disabled="isLoading" @click="queryWeather">查询</button>
      </div>
      <pre v-if="lastWeather" class="kv"><span>city:</span> {{ lastWeather.city }}
<span>tempC:</span> {{ lastWeather.tempC }}°C
<span>humidity:</span> {{ lastWeather.humidity }}%
<span>wind:</span> {{ lastWeather.wind }}
<span>observedAt:</span> {{ lastWeather.observedAt }}</pre>
      <p v-else class="empty">（输入城市点查询）</p>
    </section>

    <section v-if="lastResult || lastError" class="debug">
      <details>
        <summary>原始响应（最近一次）</summary>
        <pre v-if="lastError" class="err">{{ lastError }}</pre>
        <pre v-else>{{ lastResult }}</pre>
      </details>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.nav {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nav a {
  color: #1976d2;
  text-decoration: none;
  font-size: 14px;
}

.nav a:hover {
  text-decoration: underline;
}

.logout {
  padding: 6px 12px;
}

.hint {
  background: #f5f5f5;
  padding: 12px 16px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
}

.tabs {
  display: flex;
  gap: 4px;
  margin: 16px 0;
  border-bottom: 1px solid #ccc;
}

.tabs button {
  padding: 8px 16px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tabs button.active {
  border-bottom-color: #1976d2;
  color: #1976d2;
  font-weight: 600;
}

.form {
  display: grid;
  gap: 8px;
  grid-template-columns: 200px 1fr;
  margin-bottom: 16px;
}

.form label {
  display: contents;
}

.form input,
.form select {
  padding: 6px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.form button {
  grid-column: 2;
  padding: 6px 16px;
}

.tags {
  grid-column: 2;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  list-style: none;
  padding: 0;
}

.tags li {
  background: #e3f2fd;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
}

.tags button {
  background: transparent;
  border: none;
  color: #999;
  cursor: pointer;
  padding: 0 4px;
}

.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.rows th,
.rows td {
  padding: 6px 8px;
  border-bottom: 1px solid #eee;
  text-align: left;
}

.empty {
  color: #999;
  font-style: italic;
}

.ok {
  background: #e8f5e9;
  padding: 8px 12px;
  border-radius: 4px;
}

.err {
  background: #ffebee;
  padding: 8px 12px;
  color: #c62828;
}

.kv {
  background: #fafafa;
  padding: 8px 12px;
  border-radius: 4px;
  border: 1px solid #eee;
}

.kv span {
  display: inline-block;
  width: 100px;
  font-weight: 600;
  color: #666;
}

.debug {
  margin-top: 24px;
  border-top: 1px dashed #ccc;
  padding-top: 12px;
}

.debug pre {
  background: #f5f5f5;
  padding: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
