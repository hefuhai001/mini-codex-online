/**
 * 作用：代理核心（执行层）。主代理在容器中循环调用工具执行 →
 *       可并行派发拥有独立容器的子代理 → 汇总并输出最终总结。
 * 使用位置：仅被 app/api/chat/route.ts 调用，是唯一的代理入口。
 * 输入：TaskInput { cfg 模型配置, task 用户任务, files 已上传文件, sandboxId, image, language, history, emit, signal }。
 * 输出：无返回值，通过 emit 推送 AgentEvent 流（status/plan/step/tool/subagent/delta/container/error/done）。
 * 依赖拆分：
 *   - 系统提示词与语言约束见 lib/prompts.ts
 *   - 计划生成（planTask）与通用小工具（asString / clampTimeout）见 lib/planner.ts
 *   - 工具集定义（MAIN_TOOLS / SUBAGENT_TOOLS）见 lib/tools.ts
 */
import { randomUUID } from "node:crypto";
import {
  parseFallbackToolCall,
  streamChat,
  type LlmMessage,
  type LlmToolCall,
  type LLMConfig,
  type ToolSchema,
} from "./llm";
import { MAIN_TOOLS, SUBAGENT_TOOLS } from "./tools";
import {
  DEFAULT_IMAGE,
  Sandbox,
  WORKDIR,
  subagentHostDir,
  truncate,
  type ExecOutcome,
} from "./sandbox";
import type { AgentEvent, Plan, PlanStep, StepStatus, UploadedFileRef } from "./types";
import { MAIN_SYSTEM, SUBAGENT_SYSTEM, languageRule } from "./prompts";
import { asString, clampTimeout, planTask } from "./planner";

export interface TaskInput {
  cfg: LLMConfig;
  task: string;
  files?: UploadedFileRef[];
  sandboxId?: string;
  image?: string;
  /** 回复语言：zh-CN / en / auto，默认取 settings 或 AGENT_LANGUAGE 环境变量 */
  language?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

type Handler = (args: Record<string, unknown>) => Promise<ExecOutcome>;

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
  langRule?: string;
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
        langRule: ctx.langRule,
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
  /** 语言约束，追加到系统提示词末尾 */
  langRule?: string;
}): Promise<string> {
  const { emit, signal } = opts;
  const systemPrompt = [opts.system, opts.langRule].filter(Boolean).join("\n\n");
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
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
  langRule = "",
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
    `请开始执行。每一步用 update_step 同步状态；独立子任务用 dispatch_subagent 并行派发；完成后调用 finish。${langRule ? `\n${langRule}` : ""}`,
  );
  return parts.join("\n\n");
}

export async function runTask(input: TaskInput): Promise<void> {
  const { cfg, emit, signal } = input;
  const files = input.files ?? [];
  const langRule = languageRule(input.language || process.env.AGENT_LANGUAGE || "zh-CN");
  try {
    emit({ type: "status", message: "正在分析需求并生成计划…" });
    const plan = await planTask(cfg, input.task, files, signal, langRule);
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
      langRule,
    });

    const summary = await runLoop({
      cfg,
      system: MAIN_SYSTEM,
      task: buildTaskPrompt(input.task, files, plan, input.history, langRule),
      sandbox,
      schemas: MAIN_TOOLS,
      handlers,
      emit,
      signal,
      maxIterations: 30,
      langRule,
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
