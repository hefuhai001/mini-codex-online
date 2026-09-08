/**
 * 作用：模型与沙箱设置弹窗（Base URL、API Key、模型、默认镜像），提供预设一键填充。
 * 使用位置：由 workspace.tsx 在点击「设置」时渲染。
 * 输入：open 是否显示、settings 当前配置、onSave / onClose 回调。
 * 输出：弹窗 JSX；保存时把新配置回传 workspace 并写入 localStorage。
 */
"use client";

import { useState } from "react";
import type { Settings } from "./types";

interface Props {
  open: boolean;
  settings: Settings;
  onSave: (next: Settings) => void;
  onClose: () => void;
}

const PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-72B-Instruct" },
  { label: "本地 Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
];

export default function SettingsDialog({ open, settings, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#111216] p-5 shadow-2xl">
        <h2 className="mb-4 text-[15px] font-medium text-zinc-100">模型与沙箱设置</h2>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] text-zinc-400">接口地址 Base URL</span>
            <input
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-2 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-400/50"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] text-zinc-400">API Key</span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder="sk-…"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-2 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-400/50"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] text-zinc-400">模型</span>
            <input
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="gpt-4o-mini"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-2 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-400/50"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] text-zinc-400">默认沙箱镜像</span>
            <input
              value={draft.image}
              onChange={(e) => setDraft({ ...draft, image: e.target.value })}
              placeholder="ubuntu:24.04"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-2 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-400/50"
            />
          </label>

          <div>
            <span className="mb-1.5 block text-[12px] text-zinc-400">快速填充</span>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() =>
                    setDraft({ ...draft, baseUrl: preset.baseUrl, model: preset.model })
                  }
                  className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-white/[0.08]"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-zinc-600">
          配置仅保存在浏览器本地（localStorage），不会上传到任何第三方。
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-zinc-400 transition-colors hover:text-zinc-200"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] text-white transition-colors hover:bg-indigo-500"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
