/**
 * 作用：OpenAI 兼容大模型客户端，支持非流式 JSON 输出、流式增量输出、function calling，
 *       并在模型不支持工具时提供纯文本兜底解析。
 * 使用位置：由 lib/agent.ts 的规划器、主代理循环与子代理循环调用。
 * 输入：LLMConfig（baseUrl/apiKey/model）、LlmMessage[]、可选 ToolSchema[]、AbortSignal。
 * 输出：chatJson() 返回字符串；streamChat() 逐块产出 { type:"delta"|"tool_calls" }；
 *       parseFallbackToolCall() 返回 { name, args } 或 null。
 */
export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: LlmToolCall[] };

function resolveEndpoint(baseUrl: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("未配置模型接口地址（Base URL）");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function headers(cfg: LLMConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey && cfg.apiKey.trim()) h.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  return h;
}

async function request(
  cfg: LLMConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(resolveEndpoint(cfg.baseUrl), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`模型接口 ${res.status}：${text.slice(0, 400)}`);
  }
  return res;
}

/** 非流式调用，优先要求 JSON 输出。 */
export async function chatJson(
  cfg: LLMConfig,
  messages: LlmMessage[],
  signal?: AbortSignal,
  temperature = 0.2,
): Promise<string> {
  const attempts: Record<string, unknown>[] = [
    { model: cfg.model, messages, temperature, response_format: { type: "json_object" } },
    { model: cfg.model, messages, temperature },
  ];
  let lastError = "";
  for (const body of attempts) {
    try {
      const res = await request(cfg, body, signal);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data?.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (signal?.aborted) break;
    }
  }
  throw new Error(lastError || "模型调用失败");
}

function mergeToolCall(target: LlmToolCall[], delta: Record<string, unknown>): void {
  const index = typeof delta.index === "number" ? delta.index : target.length;
  if (!target[index]) {
    target[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
  }
  const current = target[index];
  if (typeof delta.id === "string" && delta.id) current.id += delta.id;
  const fn = delta.function as { name?: string; arguments?: string } | undefined;
  if (fn?.name) current.function.name += fn.name;
  if (typeof fn?.arguments === "string") current.function.arguments += fn.arguments;
}

/** 流式调用，产出文本增量与工具调用。 */
export async function* streamChat(
  cfg: LLMConfig,
  messages: LlmMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal,
  temperature = 0.2,
): AsyncGenerator<StreamChunk> {
  const withTools: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature,
    stream: true,
  };
  if (tools.length) {
    withTools.tools = tools;
    withTools.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await request(cfg, withTools, signal);
  } catch (err) {
    // 部分模型不支持 tools 参数，降级为纯文本再靠约定格式解析工具调用
    if (!tools.length) throw err;
    response = await request(
      cfg,
      { model: cfg.model, messages, temperature, stream: true },
      signal,
    );
  }

  if (!response.body) throw new Error("模型接口未返回数据流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls: LlmToolCall[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = json.choices as
        | { delta?: Record<string, unknown>; message?: Record<string, unknown> }[]
        | undefined;
      const delta = choices?.[0]?.delta ?? choices?.[0]?.message;
      if (!delta) continue;
      const text = delta.content ?? delta.reasoning_content;
      if (typeof text === "string" && text) yield { type: "delta", text };
      if (Array.isArray(delta.tool_calls)) {
        for (const item of delta.tool_calls as Record<string, unknown>[]) {
          mergeToolCall(calls, item);
        }
      }
    }
  }

  const valid = calls.filter((c) => c.function?.name);
  if (valid.length) yield { type: "tool_calls", calls: valid };
}

/** 从纯文本中兜底解析工具调用（模型不支持 function calling 时使用）。 */
export function parseFallbackToolCall(
  content: string,
): { name: string; args: Record<string, unknown> } | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], content];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      const name = (parsed.tool ?? parsed.name ?? parsed.action) as string | undefined;
      if (typeof name !== "string" || !name) continue;
      const args = (parsed.args ?? parsed.arguments ?? parsed.parameters ?? {}) as Record<
        string,
        unknown
      >;
      return { name, args: typeof args === "object" && args ? args : {} };
    } catch {
      continue;
    }
  }
  return null;
}
