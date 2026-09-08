/**
 * 作用：全项目共享的类型与 SSE 事件协议（计划、沙箱信息、上传文件引用、AgentEvent）。
 * 使用位置：lib/agent.ts、lib/sandbox.ts、app/api/*、app/components/* 共同引用，是前后端数据契约。
 * 输入：无（纯类型声明，运行时无副作用）。
 * 输出：导出 StepStatus / PlanStep / Plan / SandboxInfo / UploadedFileRef / AgentEvent 等类型。
 */
export type StepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: StepStatus;
  result?: string;
}

export interface Plan {
  summary: string;
  image?: string;
  steps: PlanStep[];
}

export interface SandboxInfo {
  id: string;
  name: string;
  image: string;
  createdAt: number;
  /** 最近一次活动时间，用于空闲自动回收 */
  lastActivityAt: number;
  label?: string;
  role?: "main" | "sub";
  parentId?: string;
}

export interface UploadedFileRef {
  name: string;
  path: string;
  size: number;
}

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "plan"; plan: Plan }
  | { type: "step"; stepId: string; status: StepStatus; result?: string }
  | {
      type: "container";
      action: "created" | "removed";
      sandbox: SandboxInfo;
    }
  | {
      type: "tool";
      phase: "start" | "end";
      id: string;
      name: string;
      args?: unknown;
      result?: string;
      ok?: boolean;
      subagentId?: string;
    }
  | {
      type: "subagent";
      phase: "start" | "end";
      id: string;
      task: string;
      label?: string;
      summary?: string;
    }
  | { type: "delta"; text: string; subagentId?: string }
  | { type: "error"; message: string }
  | {
      type: "done";
      summary?: string;
      sandbox?: SandboxInfo;
      plan?: Plan;
    };
