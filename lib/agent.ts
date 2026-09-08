/**
 * 作用：代理核心。生成任务计划 → 主代理在容器中循环调用工具执行 →
 *       可并行派发拥有独立容器的子代理 → 汇总并输出最终总结。
 * 使用位置：仅被 app/api/chat/route.ts 调用，是唯一的代理入口。
 * 输入：TaskInput { cfg 模型配置, task 用户任务, files 已上传文件, sandboxId, image, history, emit, signal }。
 * 输出：无返回值，通过 emit 推送 AgentEvent 流（status/plan/step/tool/subagent/delta/container/error/done）。
 */
import { randomUUID } from "node:crypto";
import {
  chatJson,
  parseFallbackToolCall,
  streamChat,
  type LlmMessage,
  type LlmToolCall,
  type LLMConfig,
  type ToolSchema,
} from "./llm";
import {
  DEFAULT_IMAGE,
  HOST_WORKSPACE_DIR,
  Sandbox,
  WORKDIR,
  subagentHostDir,
  truncate,
  type ExecOutcome,
} from "./sandbox";
import type { AgentEvent, Plan, PlanStep, StepStatus, UploadedFileRef } from "./types";

const MOUNT_HINT = HOST_WORKSPACE_DIR
  ? `- 容器内 ${WORKDIR} 已挂载到宿主机目录 ${HOST_WORKSPACE_DIR}，产出的文件在宿主机上可直接查看`
  : "";

const MAIN_SYSTEM = `你是 Mini Codex —— 在一个一次性 Docker 容器中完成用户任务的编码代理。

环境约定：
- 容器内工作目录是 ${WORKDIR}，用户上传的文件位于 ${WORKDIR}/uploads
${MOUNT_HINT}
- 容器可能是极简镜像，缺什么工具就装什么（Debian/Ubuntu 用：DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y <pkg>）
- 你无法访问宿主机，所有操作只能通过工具在容器内完成

工作方式：
1. 紧扣用户目标，不做无关的事
2. 每开始/结束一个计划步骤，调用 update_step 更新状态
3. 多个互不依赖的子任务，用 dispatch_subagent 并行派发，每个子代理拥有独立容器
4. 命令要有超时意识，长任务拆开执行；运行前先确认基础命令存在
5. 写脚本用 write_file 写入文件，再用 exec 执行，不要依赖 heredoc
6. 出错时先看 stderr 再修正，反复失败要如实汇报，不要假装成功
7. 全部完成后调用 finish，用中文给出简洁总结：做了什么、产物路径、如何运行/验证`;

const SUBAGENT_SYSTEM = `你是 Mini Codex 派出的子代理，在一个独立的临时容器中执行单一子任务。

规则：
- 只完成分配给你的子任务，不要扩大范围
- 工作目录 ${WORKDIR}，缺少的工具自行安装
${MOUNT_HINT}
- 用 exec 运行命令，用 write_file 写文件，用 read_file / list_files 查看结果
- 完成后必须调用 finish，用中文返回：执行结果、产物路径、验证方式、遇到的问题`;

const PLANNER_SYSTEM = `你是任务规划器。根据用户需求输出严格 JSON，不要任何额外文字，不要 markdown 代码块：
{
  "summary": "一句话说明目标",
  "image": "推荐的一个 Docker 镜像，例如 ubuntu:24.04 / python:3.12-slim / node:22-slim",
  "steps": [{"title": "步骤名", "detail": "具体做法"}]
}
要求：steps 3-7 步，按执行顺序排列，彼此尽量独立可并行。`;

const MAIN_TOOLS: ToolSchema[] = [
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

const SUBAGENT_TOOLS: ToolSchema[] = MAIN_TOOLS.filter((t) =>
  ["exec", "write_file", "read_file", "list_files", "finish"].includes(t.function.name),
);

export interface TaskInput {
  cfg: LLMConfig;
  task: string;
  files?: UploadedFileRef[];
  sandboxId?: string;
  image?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

type Handler = (args: Record<string, unknown>) => Promise<ExecOutcome>;

function clampTimeout(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 120000;
  return Math.min(Math.max(Math.round(n), 1000), 600000);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function extractJson(raw: string): Record<string, unknown> | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.unshift(fenced[1]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
        } catch {
          /* continue */
        }
      }
    }
  }
  return null;
}

function normalizePlan(raw: string, fallbackTask: string): Plan {
  const parsed = extractJson(raw);
  const rawSteps = Array.isArray(parsed?.steps) ? (parsed?.steps as unknown[]) : [];
  const steps: PlanStep[] = rawSteps.slice(0, 10).map((item, index) => {
    const id = `step-${index + 1}`;
    if (typeof item === "string") return { id, title: item, status: "pending" as StepStatus };
    const obj = (item ?? {}) as Record<string, unknown>;
    return {
      id,
      title: asString(obj.title ?? obj.task, `步骤 ${index + 1}`),
      detail: obj.detail ? asString(obj.detail) : undefined,
      status: "pending" as StepStatus,
    };
  });
  if (!steps.length) {
    steps.push({ id: "step-1", title: "完成用户需求", detail: fallbackTask, status: "pending" });
  }
  return {
    summary: asString(parsed?.summary, fallbackTask).slice(0, 600),
    image: typeof parsed?.image === "string" && parsed.image.trim() ? parsed.image.trim() : undefined,
    steps,
  };
}

async function planTask(
  cfg: LLMConfig,
  task: string,
  files: UploadedFileRef[],
  signal?: AbortSignal,
): Promise<Plan> {
  const fileHint = files.length
    ? `\n用户已上传文件（容器中路径）：\n${files
        .map((f) => `- ${f.path}（${f.name}，${Math.max(1, Math.round(f.size / 1024))} KB）`)
        .join("\n")}`
    : "";
  const raw = await chatJson(
    cfg,
    [
      { role: "system", content: PLANNER_SYSTEM },
      { role: "user", content: `用户需求：\n${task}${fileHint}` },
    ],
    signal,
  );
  return normalizePlan(raw, task);
}

function createWorkerHandlers(sandbox: Sandbox, signal?: AbortSignal): Record<string, Handler> {
  return {
    exec: async (args) =>
      sandbox.exec(asString(args.command), clampTimeout(args.timeout_ms), signal),
    write_file: async (args) =>
      sandbox.writeFile(asString(args.path), asString(args.content)),
    read_file: async (args) => sandbox.readFile(asString(args.path)),
    list_files: async (args) => sandbox.listFiles(args.path ? asString(args.path) : undefined),
    finish: async (args) => ({ ok: true, output: asString(args.summary, "完成") }),
  };
}

function createMainHandlers(ctx: {
  sandbox: Sandbox;
  emit: (event: AgentEvent) => void;
  steps: PlanStep[];
  cfg: LLMConfig;
  signal?: AbortSignal;
  image?: string;
}): Record<string, Handler> {
  const handlers = createWorkerHandlers(ctx.sandbox, ctx.signal);
  let subIndex = 0;

  handlers.update_step = async (args) => {
    const rawId = asString(args.step_id);
    const step =
      ctx.steps.find((s) => s.id === rawId) ??
      ctx.steps.find((s) => s.id === `step-${rawId}`) ??
      ctx.steps.find((s) => s.title === rawId);
    const status = (
      ["pending", "running", "done", "failed", "skipped"].includes(asString(args.status))
        ? asString(args.status)
        : "running"
    ) as StepStatus;
    const note = args.note ? asString(args.note) : undefined;
    if (step) {
      step.status = status;
      if (note) step.result = note;
    }
    ctx.emit({ type: "step", stepId: step?.id ?? rawId, status, result: note });
    return { ok: true, output: `步骤 ${step?.id ?? rawId} → ${status}` };
  };

  handlers.dispatch_subagent = async (args) => {
    const task = asString(args.task).trim();
    if (!task) return { ok: false, output: "缺少子任务描述（task）" };
    const label = asString(args.label).trim() || undefined;
    const id = `sub-${++subIndex}-${randomUUID().slice(0, 6)}`;
    ctx.emit({ type: "subagent", phase: "start", id, task, label });

    const sub = await Sandbox.create({
      image: args.image ? asString(args.image) : ctx.image,
      label: label ?? id,
      role: "sub",
      parentId: ctx.sandbox.info.id,
      hostDir: subagentHostDir(id),
    });
    ctx.emit({ type: "container", action: "created", sandbox: sub.info });

    try {
      const summary = await runLoop({
        cfg: ctx.cfg,
        system: SUBAGENT_SYSTEM,
        task,
        sandbox: sub,
        schemas: SUBAGENT_TOOLS,
        handlers: createWorkerHandlers(sub, ctx.signal),
        emit: ctx.emit,
        signal: ctx.signal,
        maxIterations: 14,
        subagentId: id,
      });
      const listing = await sub.listFiles(WORKDIR).catch(() => ({ ok: false, output: "" }));
      ctx.emit({
        type: "subagent",
        phase: "end",
        id,
        task,
        label,
        summary: truncate(summary, 4000),
      });
      return {
        ok: true,
        output: `子代理（${label ?? id}）完成：\n${truncate(summary, 6000)}\n\n容器内 ${WORKDIR} 内容：\n${truncate(listing.output, 2000)}`,
      };
    } finally {
      await sub.destroy().catch(() => undefined);
      ctx.emit({ type: "container", action: "removed", sandbox: sub.info });
    }
  };

  return handlers;
}

async function runLoop(opts: {
  cfg: LLMConfig;
  system: string;
  task: string;
  sandbox: Sandbox;
  schemas: ToolSchema[];
  handlers: Record<string, Handler>;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  maxIterations: number;
  subagentId?: string;
}): Promise<string> {
  const { emit, signal } = opts;
  const messages: LlmMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];

  let finished = false;
  let finishSummary = "";
  let latestText = "";

  const handlers: Record<string, Handler> = { ...opts.handlers };
  const originalFinish = handlers.finish;
  handlers.finish = async (args) => {
    finished = true;
    finishSummary = asString(args.summary) || latestText;
    return originalFinish ? originalFinish(args) : { ok: true, output: "完成" };
  };

  for (let turn = 0; turn < opts.maxIterations && !finished; turn++) {
    if (signal?.aborted) throw new Error("任务已取消");
    opts.sandbox.touch();

    let content = "";
    let calls: LlmToolCall[] = [];

    for await (const chunk of streamChat(opts.cfg, messages, opts.schemas, signal)) {
      if (chunk.type === "delta") {
        content += chunk.text;
        emit({ type: "delta", text: chunk.text, subagentId: opts.subagentId });
      } else {
        calls = chunk.calls;
      }
    }

    if (!calls.length) {
      const fallback = parseFallbackToolCall(content);
      if (fallback && handlers[fallback.name]) {
        calls = [
          {
            id: `fallback-${turn}`,
            type: "function",
            function: { name: fallback.name, arguments: JSON.stringify(fallback.args) },
          },
        ];
      }
    }

    if (content.trim()) latestText = content.trim();
    messages.push({
      role: "assistant",
      content,
      ...(calls.length ? { tool_calls: calls } : {}),
    });

    if (!calls.length) break;

    const execute = async (call: LlmToolCall) => {
      const id = `${opts.subagentId ?? "main"}-${turn}-${call.id || randomUUID()}`;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      emit({
        type: "tool",
        phase: "start",
        id,
        name: call.function.name,
        args,
        subagentId: opts.subagentId,
      });
      let outcome: ExecOutcome;
      try {
        const handler = handlers[call.function.name];
        outcome = handler
          ? await handler(args)
          : { ok: false, output: `未知工具：${call.function.name}` };
      } catch (err) {
        outcome = { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
      emit({
        type: "tool",
        phase: "end",
        id,
        name: call.function.name,
        result: truncate(outcome.output, 8000),
        ok: outcome.ok,
        subagentId: opts.subagentId,
      });
      return { call, outcome };
    };

    const parallel = calls.length > 1 && calls.every((c) => c.function.name === "dispatch_subagent");
    let results: { call: LlmToolCall; outcome: ExecOutcome }[];
    if (parallel) {
      results = await Promise.all(calls.map(execute));
    } else {
      results = [];
      for (const call of calls) results.push(await execute(call));
    }

    for (const { call, outcome } of results) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: outcome.output,
      });
    }
  }

  return finishSummary || latestText;
}

function buildTaskPrompt(
  task: string,
  files: UploadedFileRef[],
  plan: Plan,
  history?: { role: "user" | "assistant"; content: string }[],
): string {
  const parts: string[] = [];
  if (history?.length) {
    const recent = history.slice(-6);
    parts.push(
      `历史对话：\n${recent
        .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 800)}`)
        .join("\n")}`,
    );
  }
  parts.push(`用户任务：\n${task}`);
  if (files.length) {
    parts.push(
      `用户已上传并放入容器的文件：\n${files.map((f) => `- ${f.path}（${f.name}）`).join("\n")}`,
    );
  }
  parts.push(
    `执行计划：\n${plan.steps.map((s) => `- ${s.id}｜${s.title}${s.detail ? `：${s.detail}` : ""}`).join("\n")}`,
  );
  parts.push(
    `请开始执行。每一步用 update_step 同步状态；独立子任务用 dispatch_subagent 并行派发；完成后调用 finish。`,
  );
  return parts.join("\n\n");
}

export async function runTask(input: TaskInput): Promise<void> {
  const { cfg, emit, signal } = input;
  const files = input.files ?? [];
  try {
    emit({ type: "status", message: "正在分析需求并生成计划…" });
    const plan = await planTask(cfg, input.task, files, signal);
    emit({ type: "plan", plan });

    // 会话空闲超过阈值时容器会被自动回收，这里取不到了就重新创建
    let sandbox = input.sandboxId ? await Sandbox.get(input.sandboxId) : undefined;
    if (!sandbox) {
      const image = plan.image || input.image || DEFAULT_IMAGE;
      emit({ type: "status", message: `正在创建临时容器（镜像 ${image}）…` });
      sandbox = await Sandbox.create({ image, label: "主任务", role: "main" });
    }
    emit({ type: "container", action: "created", sandbox: sandbox.info });

    const handlers = createMainHandlers({
      sandbox,
      emit,
      steps: plan.steps,
      cfg,
      signal,
      image: plan.image || input.image,
    });

    const summary = await runLoop({
      cfg,
      system: MAIN_SYSTEM,
      task: buildTaskPrompt(input.task, files, plan, input.history),
      sandbox,
      schemas: MAIN_TOOLS,
      handlers,
      emit,
      signal,
      maxIterations: 30,
    });

    emit({ type: "done", summary: truncate(summary, 8000), sandbox: sandbox.info, plan });
  } catch (err) {
    if (signal?.aborted) {
      emit({ type: "error", message: "任务已取消" });
      return;
    }
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
