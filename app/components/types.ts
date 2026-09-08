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
