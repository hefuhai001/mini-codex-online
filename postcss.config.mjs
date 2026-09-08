/**
 * 作用：PostCSS 配置，启用 Tailwind CSS v4 的 @tailwindcss/postcss 插件。
 * 使用位置：Next.js 在开发环境与构建时编译 CSS 使用。
 * 输入：项目中的 CSS 文件（主要是 app/globals.css）。
 * 输出：编译后的 CSS（Tailwind 生成的工具类与变量）。
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
