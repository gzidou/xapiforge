/**
 * @xapiforge/adapter-react-native — React Native TokenStore adapter
 *
 * 使用 react-native-keychain 或 react-native-encrypted-storage。
 * 调用方需自行安装对应的 RN 库（不在本包 package.json 里，AGENTS.md 约定）。
 */
import type { TokenStore } from "@xapiforge/core";

// react-native-keychain 最小类型（类型见 rn-modules.d.ts，运行时动态 import）
interface KeychainModule {
  setGenericPassword(
    username: string,
    password: string,
    options?: { service?: string },
  ): Promise<boolean>;
  getGenericPassword(options?: {
    service?: string;
  }): Promise<false | { username: string; password: string }>;
  resetGenericPassword(options?: { service?: string }): Promise<boolean>;
}

// react-native-encrypted-storage 最小类型
interface EncryptedStorageModule {
  setItem(key: string, value: string): Promise<boolean>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<boolean>;
}

// keychain 用 username 固定占位，password 存 token（与 RN 社区惯例一致）
const KEYCHAIN_USERNAME = "access_token";

/**
 * react-native-keychain 实现（存入 iOS Keychain / Android Keystore）。
 * 调用方需自行安装 `react-native-keychain`（v8+）。
 *
 * 用 setGenericPassword / getGenericPassword，service 字段区分不同账号/服务。
 * 适合 access_token / refresh_token 等敏感凭证。
 */
export function keychainStore(opts: { service: string }): TokenStore {
  const { service } = opts;
  return {
    get: async (): Promise<string | null> => {
      const keychain = (await import("react-native-keychain")) as KeychainModule;
      const creds = await keychain.getGenericPassword({ service });
      if (!creds) return null;
      return creds.password;
    },
    set: async (token: string): Promise<void> => {
      const keychain = (await import("react-native-keychain")) as KeychainModule;
      await keychain.setGenericPassword(KEYCHAIN_USERNAME, token, { service });
    },
    clear: async (): Promise<void> => {
      const keychain = (await import("react-native-keychain")) as KeychainModule;
      await keychain.resetGenericPassword({ service });
    },
  };
}

/**
 * react-native-encrypted-storage 实现（加密 SharedPreferences）。
 * 调用方需自行安装 `react-native-encrypted-storage`（v4+）。
 *
 * 适合 access_token / refresh_token 等敏感凭证（Android 加密存储）。
 * iOS 上优先用 keychainStore（Keychain 更安全）。
 */
export function encryptedStorageStore(key: string): TokenStore {
  return {
    get: async (): Promise<string | null> => {
      const storage = (await import("react-native-encrypted-storage")) as EncryptedStorageModule;
      return await storage.getItem(key);
    },
    set: async (token: string): Promise<void> => {
      const storage = (await import("react-native-encrypted-storage")) as EncryptedStorageModule;
      await storage.setItem(key, token);
    },
    clear: async (): Promise<void> => {
      const storage = (await import("react-native-encrypted-storage")) as EncryptedStorageModule;
      await storage.removeItem(key);
    },
  };
}
