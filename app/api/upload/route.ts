/**
 * 作用：把本地文件上传进临时容器（默认 /workspace/uploads），没有容器时自动创建一个。
 * 使用位置：workspace.tsx 的 uploadFiles()，服务于消息附件与侧边面板上传。
 * 输入：multipart/form-data，字段 files/file（可多个）、可选 sandboxId、image、path（目标目录）。
 * 输出：JSON { sandbox, files:[{ name, path, size }], failures:string[] }。
 */
import { Sandbox, WORKDIR } from "@/lib/sandbox";
import { sanitizePath } from "@/lib/docker";
import type { UploadedFileRef } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_FILE_SIZE = 50 * 1024 * 1024;

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\w.\-一-龥]/g, "_").slice(0, 120) || "file";
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "请求不是合法的 multipart 表单" }, { status: 400 });
  }

  const files = form
    .getAll("files")
    .concat(form.getAll("file"))
    .filter((item): item is File => typeof item !== "string" && typeof item.arrayBuffer === "function");

  if (!files.length) return Response.json({ error: "没有收到文件" }, { status: 400 });

  const sandboxId = form.get("sandboxId");
  const image = form.get("image");
  const targetDir = sanitizePath(String(form.get("path") ?? `${WORKDIR}/uploads`), `${WORKDIR}/uploads`);

  try {
    let sandbox: Sandbox | undefined;
    if (typeof sandboxId === "string" && sandboxId.trim()) {
      // 容器可能已被空闲回收，取不到就新建一个
      sandbox = await Sandbox.get(sandboxId.trim()).catch(() => undefined);
    }
    if (!sandbox) {
      sandbox = await Sandbox.create({
        image: typeof image === "string" ? image : undefined,
        label: "文件上传",
        role: "main",
      });
    }

    const uploaded: UploadedFileRef[] = [];
    const failures: string[] = [];

    for (const file of files) {
      const name = safeName(file.name);
      const dest = `${targetDir}/${name}`;
      try {
        if (file.size > MAX_FILE_SIZE) {
          failures.push(`${name}：超过 50MB 上限`);
          continue;
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await sandbox.writeFile(dest, buffer);
        if (!result.ok) {
          failures.push(`${name}：${result.output}`);
          continue;
        }
        uploaded.push({ name, path: dest, size: file.size });
      } catch (err) {
        failures.push(`${name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return Response.json({
      sandbox: sandbox.info,
      files: uploaded,
      failures,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
