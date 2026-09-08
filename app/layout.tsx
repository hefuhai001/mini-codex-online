/**
 * 作用：根布局，定义 <html>/<body>、字体变量、页面元数据，并引入全局样式。
 * 使用位置：Next.js App Router 的根布局，包裹所有页面。
 * 输入：children（当前路由页面内容）。
 * 输出：完整的 HTML 文档骨架。
 */
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mini Codex",
  description: "计划任务、派发子代理，并在 WSL 的临时 Docker 容器中执行脚本",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full h-full flex flex-col">{children}</body>
    </html>
  );
}
