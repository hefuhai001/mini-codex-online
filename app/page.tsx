/**
 * 作用：应用首页（路由 /），直接承载对话工作区。
 * 使用位置：Next.js App Router 的 app/page.tsx，访问 / 时渲染。
 * 输入：无 props（模型配置等状态在 Workspace 内部维护）。
 * 输出：渲染 <Workspace /> 客户端组件。
 */
import Workspace from "./components/workspace";

export default function Home() {
  return <Workspace />;
}
