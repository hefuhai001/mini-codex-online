/**
 * 作用：渲染对话消息列表。助手消息按「时间线块」顺序穿插展示正文、状态、工具调用与子代理卡片，
 *       并自带滚动容器：用户停留在底部时自动跟随，向上翻阅时不再被强行拉回。
 * 使用位置：由 workspace.tsx 渲染在页面中部的滚动区（自身即滚动容器）。
 * 输入：items: ChatItem[]（来自 workspace 的消息状态）。
 * 输出：消息区 JSX；提供「回到底部」按钮，除滚动控制外无其他副作用、不发请求。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatItem, SubagentEvent, TimelineBlock, ToolEvent } from "./types";
import type { UploadedFileRef } from "@/lib/types";

const TOOL_LABELS: Record<string, string> = {
  exec: "执行脚本",
  write_file: "写入文件",
  read_file: "读取文件",
  list_files: "查看目录",
  update_step: "更新步骤",
  dispatch_subagent: "派发子代理",
  finish: "完成任务",
};

function ToolCard({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const failed = tool.ok === false;
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            tool.running ? "animate-pulse bg-amber-400" : failed ? "bg-rose-400" : "bg-emerald-400"
          }`}
        />
        <span className="shrink-0 text-[12px] font-medium text-zinc-200">
          {TOOL_LABELS[tool.name] ?? tool.name}
        </span>
        <span className="truncate font-mono text-[11px] text-zinc-500">{tool.args}</span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-600">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-white/10 px-3 py-2">
          {tool.name === "exec" || tool.name === "write_file" ? (
            <div>
              <div className="mb-1 text-[11px] text-zinc-500">
                {tool.name === "exec" ? "命令" : "内容"}
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
                {tool.args}
              </pre>
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-[11px] text-zinc-500">结果</div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
              {tool.running ? "运行中…" : (tool.result ?? "—")}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function SubagentCard({ sub }: { sub: SubagentEvent }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-xl border border-indigo-400/20 bg-indigo-400/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            sub.running ? "animate-pulse bg-indigo-300" : "bg-emerald-400"
          }`}
        />
        <span className="text-[12px] font-medium text-indigo-200">
          子代理 · {sub.label ?? sub.id}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
          {sub.running ? "运行中" : "已完成"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-indigo-400/10 px-3 py-2">
          <div className="text-[12px] text-zinc-400">{sub.task}</div>
          {sub.tools.length > 0 && (
            <div className="space-y-1.5">
              {sub.tools.map((tool) => (
                <ToolCard key={tool.id} tool={tool} />
              ))}
            </div>
          )}
          {sub.summary && (
            <div className="whitespace-pre-wrap rounded bg-black/30 p-2 text-[12px] leading-relaxed text-zinc-300">
              {sub.summary}
            </div>
          )}
          {!sub.summary && sub.output && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-zinc-500">
              {sub.output.slice(-800)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function AttachmentChips({ files }: { files: UploadedFileRef[] }) {
  if (!files.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <span
          key={f.path + f.name}
          className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-zinc-400"
        >
          {f.name}
        </span>
      ))}
    </div>
  );
}

function BlockView({ block }: { block: TimelineBlock }) {
  switch (block.kind) {
    case "text":
      return (
        <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-zinc-200">
          {block.text}
        </div>
      );
    case "status":
      return (
        <div className="flex items-center gap-2 text-[12px] text-zinc-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500" />
          {block.text}
        </div>
      );
    case "tool":
      return <ToolCard tool={block.tool} />;
    case "subagent":
      return <SubagentCard sub={block.sub} />;
    case "error":
      return (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
          {block.message}
        </div>
      );
    default:
      return null;
  }
}

function AssistantBody({ item }: { item: ChatItem }) {
  return (
    <div className="space-y-2">
      {item.blocks.map((block) => (
        <BlockView key={block.id} block={block} />
      ))}
    </div>
  );
}

export default function MessageList({ items }: { items: ChatItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const prevCountRef = useRef(items.length);
  const [pinned, setPinned] = useState(true);

  const isAtBottom = (el: HTMLDivElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = isAtBottom(el);
    pinnedRef.current = atBottom;
    setPinned((prev) => (prev === atBottom ? prev : atBottom));
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 发送新消息（一次新增用户+助手两条）时强制回到底部
    const forced = items.length > prevCountRef.current + 1;
    prevCountRef.current = items.length;
    if (!forced && !pinnedRef.current) return;
    pinnedRef.current = true;
    setPinned(true);
    el.scrollTop = el.scrollHeight;
  }, [items]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  };

  return (
    <div className="relative h-full">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
          {items.length === 0 && (
            <div className="py-16 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-lg">
                ⌘
              </div>
              <h2 className="text-[15px] font-medium text-zinc-300">Mini Codex</h2>
              <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-zinc-500">
                描述你要做的事，我会生成计划、在 WSL 的临时 Docker 容器里执行脚本，并可并行派发子代理。
                <br />
                先点右上角「设置」填写模型接口，再发送第一条消息。
              </p>
            </div>
          )}

          {items.map((item) =>
            item.role === "user" ? (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-[14px] leading-relaxed text-white">
                  <div className="whitespace-pre-wrap">{item.content}</div>
                  <AttachmentChips files={item.attachments ?? []} />
                </div>
              </div>
            ) : (
              <div key={item.id} className="flex gap-3">
                <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-[11px] text-zinc-400">
                  C
                </div>
                <div className="min-w-0 flex-1">
                  <AssistantBody item={item} />
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-[#14161a] px-3 py-1.5 text-[12px] text-zinc-300 shadow-lg transition-colors hover:bg-white/10"
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}
