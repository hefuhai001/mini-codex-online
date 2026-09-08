import { dockerStatus } from "@/lib/docker";
import { IDLE_TIMEOUT_MS, Sandbox, listSandboxes, truncate } from "@/lib/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const status = await dockerStatus().catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  return Response.json({
    docker: status,
    sandboxes: listSandboxes(),
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
}

interface SandboxRequest {
  action?: "create" | "exec" | "remove";
  sandboxId?: string;
  image?: string;
  command?: string;
  timeoutMs?: number;
}

export async function POST(req: Request) {
  let body: SandboxRequest;
  try {
    body = (await req.json()) as SandboxRequest;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  try {
    if (body.action === "create") {
      const sandbox = await Sandbox.create({
        image: body.image,
        label: "手动创建",
        role: "main",
      });
      return Response.json({ sandbox: sandbox.info });
    }

    if (body.action === "exec") {
      if (!body.sandboxId) return Response.json({ error: "缺少 sandboxId" }, { status: 400 });
      if (!body.command?.trim()) return Response.json({ error: "缺少命令" }, { status: 400 });
      const sandbox = await Sandbox.attach(body.sandboxId);
      const result = await sandbox.exec(body.command, body.timeoutMs ?? 120000);
      return Response.json({ result: { ...result, output: truncate(result.output, 20000) } });
    }

    if (body.action === "remove") {
      if (!body.sandboxId) return Response.json({ error: "缺少 sandboxId" }, { status: 400 });
      const sandbox = await Sandbox.attach(body.sandboxId);
      await sandbox.destroy();
      return Response.json({ ok: true });
    }

    return Response.json({ error: "不支持的 action" }, { status: 400 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
  try {
    const sandbox = await Sandbox.attach(id);
    await sandbox.destroy();
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
