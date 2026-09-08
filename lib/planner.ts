/**
 * 作用：解析用户需求，调用模型产出结构化执行计划（Plan）。
 * 使用位置：仅被 lib/agent.ts 的 runTask 调用。
 * 输入：模型配置 cfg、用户任务 task、已上传文件 files、取消信号 signal、语言约束 langRule。
 * 输出：normalizePlan 返回 Plan（summary / image / steps），planTask 是异步封装。
 * 注：asString / clampTimeout 这两个小工具也被 lib/agent.ts 的工具处理器复用，故一并放此处。
 */
import { chatJson, type LLMConfig } from "./llm";
import { PLANNER_SYSTEM } from "./prompts";
import type { Plan, PlanStep, StepStatus, UploadedFileRef } from "./types";

/** 把任意值安全转成字符串，null/undefined 时用 fallback。 */
export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

/** 把超时参数收敛到 [1000, 600000] 毫秒，非法值回退到 120000。 */
export function clampTimeout(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 120000;
  return Math.min(Math.max(Math.round(n), 1000), 600000);
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

export async function planTask(
  cfg: LLMConfig,
  task: string,
  files: UploadedFileRef[],
  signal?: AbortSignal,
  langRule = "",
): Promise<Plan> {
  const fileHint = files.length
    ? `\n用户已上传文件（容器中路径）：\n${files
        .map((f) => `- ${f.path}（${f.name}，${Math.max(1, Math.round(f.size / 1024))} KB）`)
        .join("\n")}`
    : "";
  const raw = await chatJson(
    cfg,
    [
      { role: "system", content: [PLANNER_SYSTEM, langRule].filter(Boolean).join("\n\n") },
      { role: "user", content: `用户需求：\n${task}${fileHint}${langRule ? `\n\n${langRule}` : ""}` },
    ],
    signal,
  );
  return normalizePlan(raw, task);
}
