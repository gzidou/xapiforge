// ESLint 9 flat config
// 严格模式：类型安全 + 一致性 + TS 特有陷阱
// Prettier 冲突规则在最后用 eslint-config-prettier 关闭
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "packages/*/dist/**",
      "packages/*/src/**/*.d.ts",
      "packages/*/src/**/*.js",
      "examples/*/dist/**",
      "tmp/**",
      "examples/*/src/api/**",
      "coverage/**",
      ".agents/**", // portable AI skills are validated and executed independently
      "eslint.config.mjs",
      "**/*.d.ts",
      "**/*.js",
      "examples/*/vite.config.ts", // vite dev config — Vite runs it as ESM, ESLint TS parser chokes
      "scripts/test/**", // 测试脚本：import workspace 包，projectService 找不到对应 tsconfig；由 tsx 直接跑覆盖
      "docs/.vitepress/**", // VitePress 配置 + 构建产物
    ],
  },
  // 基础 JS 推荐
  js.configs.recommended,
  // TS 推荐 + 严格
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Compile-time contract tests use a dedicated no-emit tsconfig rather
          // than a package tsconfig.json, so the project service treats this
          // one file as an explicit default-project entry.
          allowDefaultProject: ["packages/core/type-tests/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 类型安全
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // 一致性
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // 异步安全
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // 代码风格（基础）
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
      // 脚本需要 console
      "no-console": "off",
    },
  },
  // 最后关闭与 Prettier 冲突的格式规则
  prettier,
);
