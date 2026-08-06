// react-native-keychain 最小类型声明
//
// 为什么需要：net-adapter-react-native 不把 react-native-keychain 写进 package.json
// （AGENTS.md 约定：第三方 framework 依赖不放，让用户自己装）。
// 但 TS 的 import() 需要模块有类型声明，否则编译报 TS2307。
//
// 用户装了真实的 react-native-keychain 后，本声明被覆盖（skipLibCheck: true）。
declare module "react-native-keychain" {
  export interface UserCredentials {
    username: string;
    password: string;
  }
  export interface BaseOptions {
    service?: string;
    accessControl?: string;
    accessible?: string;
  }
  export function setGenericPassword(
    username: string,
    password: string,
    options?: BaseOptions,
  ): Promise<boolean>;
  export function getGenericPassword(options?: BaseOptions): Promise<false | UserCredentials>;
  export function resetGenericPassword(options?: BaseOptions): Promise<boolean>;
}

// react-native-encrypted-storage 最小类型声明
declare module "react-native-encrypted-storage" {
  export function setItem(key: string, value: string): Promise<boolean>;
  export function getItem(key: string): Promise<string | null>;
  export function removeItem(key: string): Promise<boolean>;
}
