/**
 * 作用：前端界面专用的类型定义（聊天项、工具事件、子代理事件、时间线块、设置、Docker 状态）。
 * 使用位置：workspace.tsx、message-list.tsx、side-panel.tsx、settings-dialog.tsx 引用。
 * 输入：无（纯类型声明）。
 * 输出：导出 ToolEvent / SubagentEvent / TimelineBlock / ChatItem / UploadedFileRef /
 *       Settings / DockerStatus 类型。
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

/**
 * 助手消息按发生顺序切分的时间线块，
 * 保证正文、工具调用、子代理卡片能按真实顺序穿插渲染。
 */
export type TimelineBlock =
  | { kind: "text"; id: string; text: string }
  | { kind: "status"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolEvent }
  | { kind: "subagent"; id: string; sub: SubagentEvent }
  | { kind: "error"; id: string; message: string };

export interface ChatItem {
  id: string;
  role: "user" | "assistant";
  /** 纯文本累计，用于拼装历史上下文 */
  content: string;
  attachments?: UploadedFileRef[];
  /** 按时间顺序排列的渲染块 */
  blocks: TimelineBlock[];
  status?: string;
  error?: string;
  running: boolean;
  /** 自增序号，用于生成块 id */
  seq: number;
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
  /** 回复语言：zh-CN / en / auto */
  language: string;
}

export interface DockerStatus {
  ok: boolean;
  version?: string;
  error?: string;
}
