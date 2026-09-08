"use client";

import { useEffect, useRef, useState } from "react";
import type { Plan, SandboxInfo, StepStatus } from "@/lib/types";
import type { DockerStatus } from "./types";

interface Props {
  plan: Plan | null;
  sandbox: SandboxInfo | null;
  docker: DockerStatus | null;
  image: string;
  busy: boolean;
  idleTimeoutMs: number;
  idleDeadlineMs: number | null;
  onIdleExpire: () => void;
  onImageChange: (value: string) => void;
  onCreate: () => void;
  onDestroy: () => void;
  onUpload: (files: File[]) => void;
  onExec: (command: string) => Promise<{ ok: boolean; output: string }>;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function IdleBadge({
  deadlineMs,
  timeoutMs,
  onExpire,
}: {
  deadlineMs: number | null;
  timeoutMs: number;
  onExpire: () => void;
}) {
  const [remaining, setRemaining] = useState<number>(() =>
    deadlineMs ? Math.max(0, deadlineMs - Date.now()) : timeoutMs,
  );

  useEffect(() => {
    if (!deadlineMs) {
      setRemaining(timeoutMs);
      return;
    }
    const tick = () => {
      const left = Math.max(0, deadlineMs - Date.now());
      setRemaining(left);
      if (left === 0) onExpire();
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadlineMs, timeoutMs, onExpire]);

  const minutes = Math.round(timeoutMs / 60000);
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-[11px]">
      <span className={`h-1.5 w-1.5 rounded-full ${remaining <= 60000 ? "bg-amber-400" : "bg-zinc-500"}`} />
      <span className="text-zinc-400">会话空闲 {minutes} 分钟后自动销毁容器</span>
      <span className="ml-auto font-mono text-zinc-300">
        {deadlineMs ? formatRemaining(remaining) : "--:--"}
      </span>
    </div>
  );
}

const STATUS_MARK: Record<StepStatus, string> = {
  pending: "○",
  running: "◐",
  done: "✓",
  failed: "✕",
  skipped: "–",
};

const STATUS_COLOR: Record<StepStatus, string> = {
  pending: "text-zinc-600",
  running: "text-amber-400 animate-pulse",
  done: "text-emerald-400",
  failed: "text-rose-400",
  skipped: "text-zinc-600",
};

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="border-b border-white/5 px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function SidePanel({
  plan,
  sandbox,
  docker,
  image,
  busy,
  idleTimeoutMs,
  idleDeadlineMs,
  onIdleExpire,
  onImageChange,
  onCreate,
  onDestroy,
  onUpload,
  onExec,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  const [executing, setExecuting] = useState(false);

  const runExec = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setExecuting(true);
    setOutput(null);
    try {
      const res = await onExec(cmd);
      setOutput({ ok: res.ok, text: res.output });
    } finally {
      setExecuting(false);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-l border-white/5 bg-[#0c0d10]">
      <Section title="沙箱容器">
        <IdleBadge deadlineMs={idleDeadlineMs} timeoutMs={idleTimeoutMs} onExpire={onIdleExpire} />
        <div className="mb-3 flex items-center gap-2 text-[12px]">
          <span
            className={`h-1.5 w-1.5 rounded-full ${docker?.ok ? "bg-emerald-400" : "bg-rose-400"}`}
          />
          <span className="text-zinc-400">
            {docker === null
              ? "检测中…"
              : docker.ok
                ? `Docker 已连接${docker.version ? ` · v${docker.version}` : ""}`
                : "Docker 不可用"}
          </span>
        </div>
        {docker && !docker.ok && docker.error && (
          <p className="mb-3 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[11px] text-rose-300">
            {docker.error}
          </p>
        )}

        <div className="space-y-2">
          <input
            value={image}
            onChange={(e) => onImageChange(e.target.value)}
            placeholder="镜像，如 ubuntu:24.04"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-indigo-400/50"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCreate}
              disabled={busy}
              className="flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:opacity-40"
            >
              新建容器
            </button>
            <button
              type="button"
              onClick={onDestroy}
              disabled={!sandbox || busy}
              className="flex-1 rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1.5 text-[12px] text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
            >
              销毁容器
            </button>
          </div>
        </div>

        {sandbox && (
          <dl className="mt-3 space-y-1 rounded-md border border-white/5 bg-white/[0.02] p-2.5 font-mono text-[11px] text-zinc-500">
            <div className="flex justify-between gap-2">
              <dt>容器</dt>
              <dd className="truncate text-zinc-300">{sandbox.name}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>镜像</dt>
              <dd className="truncate text-zinc-300">{sandbox.image}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>工作目录</dt>
              <dd className="text-zinc-300">/workspace</dd>
            </div>
          </dl>
        )}
      </Section>

      <Section title="上传文件到容器">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) onUpload(files);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="w-full rounded-md border border-dashed border-white/15 bg-white/[0.02] px-3 py-3 text-[12px] text-zinc-400 transition-colors hover:border-indigo-400/40 hover:text-zinc-200 disabled:opacity-40"
        >
          选择文件 → /workspace/uploads
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
          没有容器时会自动创建一个。上传后可直接在对话里让代理处理这些文件。
        </p>
      </Section>

      <Section title="手动执行">
        <div className="flex gap-2">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void runExec();
              }
            }}
            placeholder="ls -la /workspace"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-indigo-400/50"
          />
          <button
            type="button"
            onClick={runExec}
            disabled={!sandbox || executing}
            className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-200 transition-colors hover:bg-white/[0.08] disabled:opacity-40"
          >
            {executing ? "…" : "运行"}
          </button>
        </div>
        {output && (
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
            {output.text}
          </pre>
        )}
      </Section>

      <Section title="任务计划">
        {!plan ? (
          <p className="text-[12px] text-zinc-600">发送消息后，这里会显示自动生成的执行计划。</p>
        ) : (
          <div className="space-y-3">
            <p className="text-[12px] leading-relaxed text-zinc-300">{plan.summary}</p>
            <ol className="space-y-2">
              {plan.steps.map((step) => (
                <li key={step.id} className="flex gap-2 text-[12px]">
                  <span className={`shrink-0 ${STATUS_COLOR[step.status]}`}>
                    {STATUS_MARK[step.status]}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={
                        step.status === "done"
                          ? "text-zinc-500 line-through"
                          : "text-zinc-300"
                      }
                    >
                      {step.title}
                    </div>
                    {step.detail && (
                      <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-600">
                        {step.detail}
                      </div>
                    )}
                    {step.result && step.status !== "done" && (
                      <div className="mt-0.5 text-[11px] text-amber-400/80">{step.result}</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Section>
    </aside>
  );
}
