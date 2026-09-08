/**
 * 作用：对话主界面容器组件，管理消息列表、消费 SSE 事件、维护计划与沙箱状态、
 *       处理上传/发送/中断，并驱动空闲倒计时。
 * 使用位置：由 app/page.tsx 直接渲染，是整页唯一的状态中心。
 * 输入：用户输入的文本与附件、设置弹窗中的模型配置、侧边面板的操作回调。
 * 输出：渲染头部、MessageList、输入区、SidePanel、SettingsDialog；
 *       并向 /api/chat、/api/sandbox、/api/upload 发起请求。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MessageList from "./message-list";
import SettingsDialog from "./settings-dialog";
import SidePanel from "./side-panel";
import type { ChatItem, DockerStatus, Settings, UploadedFileRef } from "./types";
import type { AgentEvent, Plan, SandboxInfo } from "@/lib/types";

const STORAGE_KEY = "mini-codex.settings";

const DEFAULT_SETTINGS: Settings = {
  baseUrl: "",
  apiKey: "",
  model: "gpt-4o-mini",
  image: "ubuntu:24.04",
};

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

function formatArgs(name: string, args: unknown): string {
  const obj = (args ?? {}) as Record<string, unknown>;
  if (name === "exec") return String(obj.command ?? "");
  if (name === "write_file") return String(obj.path ?? "");
  if (name === "read_file" || name === "list_files") return String(obj.path ?? "");
  if (name === "dispatch_subagent") return String(obj.task ?? "");
  if (name === "finish") return String(obj.summary ?? "").slice(0, 120);
  if (name === "update_step") return `${obj.step_id ?? ""} → ${obj.status ?? ""}`;
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  if (!items.length) return items;
  const last = items[items.length - 1];
  if (last.role !== "assistant") return items;

  let next: ChatItem;
  try {
    next = structuredClone(last);
  } catch {
    next = { ...last, tools: [...last.tools], subagents: [...last.subagents] };
  }

  switch (event.type) {
    case "status":
      next.status = event.message;
      break;
    case "delta": {
      if (event.subagentId) {
        const sub = next.subagents.find((s) => s.id === event.subagentId);
        if (sub) sub.output += event.text;
        else next.content += event.text;
      } else {
        next.content += event.text;
      }
      break;
    }
    case "tool": {
      const list = event.subagentId
        ? next.subagents.find((s) => s.id === event.subagentId)?.tools
        : next.tools;
      if (!list) break;
      if (event.phase === "start") {
        list.push({
          id: event.id,
          name: event.name,
          args: formatArgs(event.name, event.args),
          running: true,
          subagentId: event.subagentId,
        });
      } else {
        const tool = list.find((t) => t.id === event.id);
        if (tool) {
          tool.running = false;
          tool.result = event.result;
          tool.ok = event.ok;
        }
      }
      break;
    }
    case "subagent": {
      if (event.phase === "start") {
        next.subagents.push({
          id: event.id,
          task: event.task,
          label: event.label,
          running: true,
          output: "",
          tools: [],
        });
      } else {
        const sub = next.subagents.find((s) => s.id === event.id);
        if (sub) {
          sub.running = false;
          sub.summary = event.summary;
        }
      }
      break;
    }
    case "error":
      next.error = event.message;
      next.running = false;
      next.status = undefined;
      break;
    case "done":
      next.running = false;
      next.status = undefined;
      if (!next.content.trim() && event.summary) next.content = event.summary;
      break;
    default:
      break;
  }

  const copy = items.slice();
  copy[copy.length - 1] = next;
  return copy;
}

export default function Workspace() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [sandbox, setSandbox] = useState<SandboxInfo | null>(null);
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<UploadedFileRef[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState(600_000);
  const [idleDeadlineMs, setIdleDeadlineMs] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((prev) => (prev === message ? null : prev));
    }, 4000);
  }, []);

  /** 任何与容器相关的活动都重置空闲倒计时，与服务端判定保持一致 */
  const markActivity = useCallback(() => {
    setIdleDeadlineMs(Date.now() + idleTimeoutMs);
  }, [idleTimeoutMs]);

  const refreshDocker = useCallback(async () => {
    try {
      const res = await fetch("/api/sandbox", { cache: "no-store" });
      const data = (await res.json()) as { docker?: DockerStatus; idleTimeoutMs?: number };
      setDocker(data.docker ?? { ok: false, error: "未知状态" });
      if (typeof data.idleTimeoutMs === "number" && data.idleTimeoutMs > 0) {
        setIdleTimeoutMs(data.idleTimeoutMs);
      }
    } catch {
      setDocker({ ok: false, error: "无法访问服务端接口" });
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) });
    } catch {
      /* ignore */
    }
    void refreshDocker();
  }, [refreshDocker]);

  const saveSettings = (next: Settings) => {
    setSettings(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setSettingsOpen(false);
    if (!next.baseUrl) flash("提示：还没填写模型接口地址，发送时会报错");
  };

  const uploadFiles = async (files: File[]): Promise<UploadedFileRef[]> => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    if (sandbox) form.append("sandboxId", sandbox.id);
    if (settings.image) form.append("image", settings.image);

    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = (await res.json()) as {
      error?: string;
      sandbox?: SandboxInfo;
      files?: UploadedFileRef[];
      failures?: string[];
    };
    if (!res.ok) throw new Error(data.error ?? "上传失败");
    if (data.sandbox) setSandbox(data.sandbox);
    if (data.failures?.length) flash(`部分文件上传失败：${data.failures.join("；")}`);
    return data.files ?? [];
  };

  const handleAttach = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    try {
      const uploaded = await uploadFiles(files);
      if (uploaded.length) {
        setAttachments((prev) => [...prev, ...uploaded]);
        markActivity();
        flash(`已上传 ${uploaded.length} 个文件到容器`);
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : "上传失败");
    }
  };

  const handlePanelUpload = async (files: File[]) => {
    try {
      const uploaded = await uploadFiles(files);
      if (uploaded.length) markActivity();
      flash(uploaded.length ? `已上传 ${uploaded.length} 个文件到 /workspace/uploads` : "没有文件被写入");
    } catch (err) {
      flash(err instanceof Error ? err.message : "上传失败");
    }
  };

  const handleIdleExpire = useCallback(() => {
    setSandbox(null);
    setIdleDeadlineMs(null);
    flash("会话空闲超时，临时容器已自动销毁");
  }, [flash]);

  const handleExec = async (command: string) => {
    if (!sandbox) return { ok: false, output: "还没有运行中的容器" };
    markActivity();
    const res = await fetch("/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "exec", sandboxId: sandbox.id, command }),
    });
    const data = (await res.json()) as { error?: string; result?: { ok: boolean; output: string } };
    if (!res.ok || !data.result) return { ok: false, output: data.error ?? "执行失败" };
    return data.result;
  };

  const createSandbox = async () => {
    try {
      flash("正在创建容器…");
      const res = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", image: settings.image }),
      });
      const data = (await res.json()) as { error?: string; sandbox?: SandboxInfo };
      if (!res.ok || !data.sandbox) throw new Error(data.error ?? "创建失败");
      setSandbox(data.sandbox);
      markActivity();
      flash(`容器已就绪：${data.sandbox.name}`);
    } catch (err) {
      flash(err instanceof Error ? err.message : "创建容器失败");
    }
  };

  const destroySandbox = async () => {
    if (!sandbox) return;
    try {
      await fetch(`/api/sandbox?id=${encodeURIComponent(sandbox.id)}`, { method: "DELETE" });
      setSandbox(null);
      setIdleDeadlineMs(null);
      flash("容器已销毁");
    } catch (err) {
      flash(err instanceof Error ? err.message : "销毁失败");
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || running) return;
    if (!settings.baseUrl) {
      setSettingsOpen(true);
      flash("请先填写模型接口地址（Base URL）");
      return;
    }

    const files = attachments;
    setInput("");
    setAttachments([]);
    setNotice(null);

    const history = items
      .filter((item) => item.content.trim())
      .map((item) => ({ role: item.role, content: item.content.slice(0, 1500) }));

    setItems((prev) => [
      ...prev,
      { id: uid(), role: "user", content: text, attachments: files, tools: [], subagents: [], running: false },
      { id: uid(), role: "assistant", content: "", tools: [], subagents: [], running: true, status: "正在初始化…" },
    ]);

    setRunning(true);
    markActivity();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          config: settings,
          sandboxId: sandbox?.id,
          files,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let message = `请求失败（${res.status}）`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          /* ignore */
        }
        setItems((prev) => applyEvent(prev, { type: "error", message }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5).trim()) as AgentEvent;
            if (event.type === "plan") setPlan(event.plan);
            else if (event.type === "step") {
              setPlan((prev) =>
                prev
                  ? {
                      ...prev,
                      steps: prev.steps.map((step) =>
                        step.id === event.stepId
                          ? { ...step, status: event.status, result: event.result ?? step.result }
                          : step,
                      ),
                    }
                  : prev,
              );
            } else if (event.type === "container") {
              if (event.action === "created" && event.sandbox.role !== "sub") {
                setSandbox(event.sandbox);
              } else if (event.action === "removed" && event.sandbox.id === sandbox?.id) {
                setSandbox(null);
              }
            } else if (event.type === "done") {
              if (event.sandbox) setSandbox(event.sandbox);
              if (event.plan) setPlan(event.plan);
            }
            if (
              event.type === "tool" ||
              event.type === "done" ||
              (event.type === "container" &&
                event.action === "created" &&
                event.sandbox.role !== "sub")
            ) {
              markActivity();
            }
            setItems((prev) => applyEvent(prev, event));
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) => applyEvent(prev, { type: "error", message }));
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setItems((prev) => {
        if (!prev.length) return prev;
        const copy = prev.slice();
        const last = copy[copy.length - 1];
        if (last.role === "assistant") copy[copy.length - 1] = { ...last, running: false, status: undefined };
        return copy;
      });
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const panel = (
    <SidePanel
      plan={plan}
      sandbox={sandbox}
      docker={docker}
      image={settings.image}
      busy={running}
      idleTimeoutMs={idleTimeoutMs}
      idleDeadlineMs={idleDeadlineMs}
      onIdleExpire={handleIdleExpire}
      onImageChange={(value) => setSettings((prev) => ({ ...prev, image: value }))}
      onCreate={createSandbox}
      onDestroy={destroySandbox}
      onUpload={handlePanelUpload}
      onExec={handleExec}
    />
  );

  return (
    <div className="flex h-screen bg-[#0a0b0d] text-zinc-100">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/5 px-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-[12px]">
              ⌘
            </span>
            <span className="text-[13px] font-medium tracking-tight">Mini Codex</span>
          </div>
          <div className="flex items-center gap-2">
            {sandbox && (
              <span className="hidden max-w-[220px] truncate rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-zinc-400 sm:inline">
                {sandbox.name}
              </span>
            )}
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="rounded-md border border-white/10 px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-white/[0.06] lg:hidden"
            >
              面板
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded-md border border-white/10 px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-white/[0.06]"
            >
              设置
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <MessageList items={items} />
        </div>

        <div className="shrink-0 border-t border-white/5 bg-[#0a0b0d] px-4 py-3">
          <div className="mx-auto w-full max-w-3xl">
            {notice && (
              <div className="mb-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] text-zinc-400">
                {notice}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((file, index) => (
                  <span
                    key={`${file.path}-${index}`}
                    className="flex items-center gap-1 rounded-md border border-indigo-400/20 bg-indigo-400/10 px-2 py-0.5 font-mono text-[11px] text-indigo-200"
                  >
                    {file.name}
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                      className="text-indigo-300/60 hover:text-indigo-200"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 transition-colors focus-within:border-indigo-400/40">
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void handleAttach(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="上传文件到容器"
                className="mb-0.5 shrink-0 rounded-md px-1.5 py-1 text-[15px] text-zinc-500 transition-colors hover:text-zinc-200"
              >
                ＋
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                rows={1}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoGrow(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="描述任务，例如：读取上传的 csv，统计各列缺失值并生成报告"
                className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-[14px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              {running ? (
                <button
                  type="button"
                  onClick={stop}
                  className="mb-0.5 shrink-0 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-[12px] text-rose-200 transition-colors hover:bg-rose-500/20"
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!input.trim()}
                  className="mb-0.5 shrink-0 rounded-md bg-indigo-600 px-3 py-1 text-[12px] text-white transition-colors hover:bg-indigo-500 disabled:opacity-30"
                >
                  发送
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-600">
              Enter 发送 · Shift+Enter 换行 · ＋ 上传文件到临时容器
            </p>
          </div>
        </div>
      </div>

      <div className="hidden w-[360px] shrink-0 lg:block">{panel}</div>

      {panelOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setPanelOpen(false)}
        >
          <div
            className="absolute right-0 top-0 h-full w-[360px] max-w-full"
            onClick={(e) => e.stopPropagation()}
          >
            {panel}
          </div>
        </div>
      )}

      <SettingsDialog
        key={String(settingsOpen)}
        open={settingsOpen}
        settings={settings}
        onSave={saveSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
