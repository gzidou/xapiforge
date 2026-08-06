<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { AuthLoginError } from "../AuthApi.js";
import { authApi } from "../main.js";

const username = ref("admin");
const password = ref("");
const tenant = ref("");
const loading = ref(false);
const error = ref<string | null>(null);

const router = useRouter();

async function onLogin() {
  loading.value = true;
  error.value = null;
  try {
    const auth = await authApi.login(username.value, password.value, tenant.value || undefined);
    localStorage.setItem("app_token", auth.token);
    if (auth.refreshToken) localStorage.setItem("app_refresh_token", auth.refreshToken);
    // Vue Router push（不 reload；保留 setup() 状态）
    void router.push("/");
  } catch (e) {
    if (e instanceof AuthLoginError) {
      error.value = `${e.message}${e.oauth2?.error ? ` (${e.oauth2.error})` : ""}`;
    } else {
      error.value = (e as Error).message;
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login">
    <h1>登录 (Demo)</h1>
    <form @submit.prevent="onLogin">
      <label>
        用户名
        <input v-model="username" type="text" autocomplete="username" />
      </label>
      <label>
        密码
        <input v-model="password" type="password" autocomplete="current-password" />
      </label>
      <label>
        租户（可选）
        <input v-model="tenant" type="text" placeholder="如 demo" />
      </label>
      <button type="submit" :disabled="loading">
        {{ loading ? "登录中..." : "登录" }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </form>
    <p class="hint">后端: http://localhost:8787（mock 服务，真后端在private network）</p>
  </div>
</template>

<style scoped>
.login {
  max-width: 360px;
  margin: 40px auto;
}

form label {
  display: block;
  margin: 12px 0;
}

form input {
  display: block;
  width: 100%;
  padding: 8px;
  box-sizing: border-box;
}

form button {
  padding: 8px 16px;
  margin-top: 12px;
}

.error {
  color: red;
}

.hint {
  color: #666;
  font-size: 12px;
}
</style>
