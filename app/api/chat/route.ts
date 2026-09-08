import { runTask } from "@/lib/agent";
import type { LLMConfig } from "@/lib/llm";
import type { AgentEvent, UploadedFileRef } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

interface ChatRequestBody {
  message?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  config?: { baseUrl?: string; apiKey?: string; model?: string; image?: string };
  sandboxId?: string;
  files?: UploadedFileRef[];
}

function resolveConfig(body: ChatRequestBody): LLMConfig {
  return {
    baseUrl: (body.config?.baseUrl ?? "").trim() || process.env.OPENAI_BASE_URL || "",
    apiKey: (body.config?.apiKey ?? "").trim() || process.env.OPENAI_API_KEY || "",
    model: (body.config?.model ?? "").trim() || process.env.OPENAI_MODEL || "gpt-4o-mini",
  };
}

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message) return Response.json({ error: "消息内容为空" }, { status: 400 });

  const cfg = resolveConfig(body);
  if (!cfg.baseUrl) {
    return Response.json({ error: "请先在设置中填写模型接口地址（Base URL）" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          closed = true;
        }
      }, 15000);

      try {
        await runTask({
          cfg,
          task: message,
          files: body.files,
          sandboxId: body.sandboxId,
          image: body.config?.image,
          history: body.history,
          emit: send,
          signal: req.signal,
        });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(keepAlive);
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
