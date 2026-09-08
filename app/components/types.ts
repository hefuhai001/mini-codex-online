/**
 * 作用：前端界面专用的类型定义（聊天项、工具事件、子代理事件、设置、Docker 状态）。
 * 使用位置：workspace.tsx、message-list.tsx、side-panel.tsx、settings-dialog.tsx 引用。
 * 输入：无（纯类型声明）。
 * 输出：导出 ToolEvent / SubagentEvent / ChatItem / UploadedFileRef / Settings / DockerStatus 类型。
 */
export interface ToolEvent {
  id: string;
  name: string;
  args: string;
  result?: string;
  ok?: boolean;
  running: boolean;
  subagentId?: string;
}

export interface SubagentEvent {
  id: string;
  task: string;
  label?: string;
  summary?: string;
  running: boolean;
  output: string;
  tools: ToolEvent[];
}

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: UploadedFileRef[];
  tools: ToolEvent[];
  subagents: SubagentEvent[];
  status?: string;
  error?: string;
  running: boolean;
}

export interface UploadedFileRef {
  name: string;
  path: string;
  size: number;
}

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  image: string;
}

export interface DockerStatus {
  ok: boolean;
  version?: string;
  error?: string;
}
