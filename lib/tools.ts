/**
 * 作用：定义代理可调用的工具集（OpenAI function calling 的 JSON Schema）。
 *       主代理拥有全部工具，子代理只保留执行类与收尾类工具（不派发二级子代理）。
 * 使用位置：仅被 lib/agent.ts 的 runLoop 用于主代理与子代理循环。
 * 输入：无（纯工具定义）。
 * 输出：导出 MAIN_TOOLS（exec/write_file/read_file/list_files/update_step/dispatch_subagent/finish）
 *       与 SUBAGENT_TOOLS（MAIN_TOOLS 的子集，用于子代理卡片）。
 */
import type { ToolSchema } from "./llm";

export const MAIN_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "exec",
      description: "在临时容器中执行 shell 命令（工作目录 /workspace）。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          timeout_ms: { type: "number", description: "超时毫秒数，默认 120000，最大 600000" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "把内容写入容器内的文件，父目录会自动创建。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "容器内绝对路径，如 /workspace/main.py" },
          content: { type: "string", description: "文件完整内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取容器内文件内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "容器内文件路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出容器内某个目录的内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "容器目录，默认 /workspace" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_step",
      description: "更新计划中某个步骤的状态。",
      parameters: {
        type: "object",
        properties: {
          step_id: { type: "string", description: "步骤 id，如 step-1" },
          status: {
            type: "string",
            enum: ["pending", "running", "done", "failed", "skipped"],
          },
          note: { type: "string", description: "可选的补充说明" },
        },
        required: ["step_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_subagent",
      description:
        "派发一个子代理，它会拿到一个全新的独立临时容器并自行完成子任务，最后返回结论。适合彼此独立、可并行的子任务。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "交给子代理的完整任务描述，需自包含" },
          label: { type: "string", description: "子代理显示名，如“数据清洗”" },
          image: { type: "string", description: "可选，子代理使用的镜像" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "所有任务完成后调用，给出最终总结。",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "给用户的中文总结" } },
        required: ["summary"],
      },
    },
  },
];

/** 子代理可用工具：执行类 + 收尾，不含 update_step / dispatch_subagent */
export const SUBAGENT_TOOLS: ToolSchema[] = MAIN_TOOLS.filter((t) =>
  ["exec", "write_file", "read_file", "list_files", "finish"].includes(t.function.name),
);
