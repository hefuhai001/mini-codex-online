/**
 * 作用：ESLint 扁平配置，启用 next/core-web-vitals 与 next/typescript 规则集。
 * 使用位置：执行 pnpm lint 或编辑器 ESLint 插件时读取。
 * 输入：项目中的源码文件（ts/tsx/js/mjs）。
 * 输出：导出配置数组；检查结果输出到终端与编辑器。
 */
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
