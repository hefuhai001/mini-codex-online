/**
 * 作用：临时容器（沙箱）生命周期管理：创建（默认把宿主机 workspace 目录挂载到容器 /workspace）、
 *       执行命令、读写文件、销毁，基于 lastActivityAt 的空闲超时自动回收巡检（每 30 秒一次），
 *       以及 syncSandboxes() 与 docker 真实状态对账（接管遗留容器、清理已停止的容器）。
 * 使用位置：lib/agent.ts（主/子代理）、app/api/sandbox/route.ts、app/api/upload/route.ts。
 * 输入：镜像名、标签、角色（main/sub）、父容器 id、挂载源目录、shell 命令与超时、文件内容（string|Buffer）。
 * 输出：Sandbox 实例；exec/writeFile 等返回 ExecOutcome { ok, output }；
 *       listSandboxes() 返回带 lastActivityAt 的 SandboxInfo[]。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  CONTAINER_PREFIX,
  createContainer,
  dockerMode,
  execInContainer,
  listManagedContainers,
  listFilesInContainer,
  readFileInContainer,
  removeContainer,
  sanitizePath,
  toWslPath,
  writeFileInContainer,
  type RunResult,
} from "./docker";
import { SandboxInfo } from "./types";

export const DEFAULT_IMAGE = process.env.SANDBOX_IMAGE ?? "ubuntu:24.04";
export const WORKDIR = process.env.SANDBOX_WORKDIR ?? "/workspace";

/** 是否把容器工作目录挂载到宿主机，默认开启（SANDBOX_MOUNT=0 关闭） */
export const MOUNT_ENABLED = (process.env.SANDBOX_MOUNT ?? "1").toLowerCase() !== "0";

function defaultHostWorkspace(): string {
  const dir = path.join(process.cwd(), "workspace");
  return dockerMode() === "wsl" ? toWslPath(dir) : dir;
}

/**
 * 宿主机侧的工作目录（容器 /workspace 的挂载源）。
 * 默认：项目根目录下的 workspace；WSL 模式下自动转成 /mnt/<盘符>/... 形式。
 */
export const HOST_WORKSPACE_DIR: string = MOUNT_ENABLED
  ? (process.env.SANDBOX_HOST_WORKSPACE ?? "").trim() || defaultHostWorkspace()
  : "";

/** 子代理使用主工作目录下的独立子目录，避免并发写冲突 */
export function subagentHostDir(key: string): string | undefined {
  if (!HOST_WORKSPACE_DIR) return undefined;
  const safe = key.replace(/[^\w.-]/g, "_");
  return `${HOST_WORKSPACE_DIR}/.subagents/${safe}`;
}

/** 会话空闲多久后销毁对应的临时容器，默认 10 分钟 */
export const IDLE_TIMEOUT_MS = resolveIdleTimeout();
const SWEEP_INTERVAL_MS = 30_000;

function resolveIdleTimeout(): number {
  const raw = Number(process.env.SANDBOX_IDLE_TIMEOUT_MS ?? 600_000);
  if (!Number.isFinite(raw) || raw <= 0) return 600_000;
  return Math.max(raw, 30_000);
}

const store = globalThis as unknown as {
  __miniCodexSandboxes?: Map<string, SandboxInfo>;
  __miniCodexReaper?: NodeJS.Timeout;
};

const sandboxes: Map<string, SandboxInfo> =
  store.__miniCodexSandboxes ?? (store.__miniCodexSandboxes = new Map());

export function listSandboxes(): SandboxInfo[] {
  return Array.from(sandboxes.values());
}

export function getSandboxInfo(id: string): SandboxInfo | undefined {
  return sandboxes.get(id);
}

/** 刷新活动时间（连带刷新父容器，避免子代理执行时主容器被回收） */
export function touchSandbox(id?: string): void {
  if (!id) return;
  const info = sandboxes.get(id);
  if (!info) return;
  info.lastActivityAt = Date.now();
  if (info.parentId) touchSandbox(info.parentId);
}

/** 回收所有空闲超时的容器，返回被销毁的容器名 */
export async function sweepIdleSandboxes(): Promise<string[]> {
  const now = Date.now();
  const removed: string[] = [];
  for (const info of Array.from(sandboxes.values())) {
    if (now - info.lastActivityAt < IDLE_TIMEOUT_MS) continue;
    sandboxes.delete(info.id);
    removed.push(info.name);
    void removeContainer(info.name).catch(() => undefined);
  }
  return removed;
}

function ensureReaper(): void {
  if (store.__miniCodexReaper) return;
  const timer = setInterval(() => {
    void sweepIdleSandboxes().catch(() => undefined);
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  store.__miniCodexReaper = timer;
}

ensureReaper();

function containerName(id: string): string {
  return `${CONTAINER_PREFIX}-${id}`;
}

/**
 * 与 docker 实际状态对账：
 * - 已退出/不存在的容器会被清理或移出注册表
 * - docker 里存在但注册表没有的容器会被接管（例如服务重启、多进程、页面刷新后）
 * 返回对账后的沙箱列表，保证"页面上看到的"和"真正在跑的"一致。
 */
export async function syncSandboxes(): Promise<SandboxInfo[]> {
  const actual = await listManagedContainers();
  const alive = new Map<string, { name: string; image: string }>();
  const dead: string[] = [];
  for (const item of actual) {
    if (item.state !== "running") {
      dead.push(item.name);
      continue;
    }
    alive.set(item.id, { name: item.name, image: item.image });
  }
  if (dead.length) {
    await Promise.all(dead.map((name) => removeContainer(name).catch(() => undefined)));
  }

  for (const id of Array.from(sandboxes.keys())) {
    if (!alive.has(id)) sandboxes.delete(id);
  }

  for (const [id, item] of alive) {
    const existing = sandboxes.get(id);
    if (existing) {
      if (!existing.image || existing.image === "unknown") existing.image = item.image;
      continue;
    }
    const now = Date.now();
    sandboxes.set(id, {
      id,
      name: item.name,
      image: item.image,
      createdAt: now,
      lastActivityAt: now,
      role: "main",
    });
  }

  return listSandboxes();
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

export interface ExecOutcome {
  ok: boolean;
  output: string;
}

export class Sandbox {
  readonly info: SandboxInfo;

  private constructor(info: SandboxInfo) {
    this.info = info;
  }

  static async create(opts: {
    image?: string;
    label?: string;
    role?: "main" | "sub";
    workdir?: string;
    parentId?: string;
    /** 挂载源目录，默认使用 HOST_WORKSPACE_DIR；传空字符串表示不挂载 */
    hostDir?: string;
  }): Promise<Sandbox> {
    const id = shortId();
    const image = (opts.image ?? "").trim() || DEFAULT_IMAGE;
    const name = containerName(id);
    const workdir = opts.workdir ?? WORKDIR;
    const hostDir = opts.hostDir ?? HOST_WORKSPACE_DIR;

    let mounted = false;
    if (hostDir) {
      try {
        mkdirSync(hostDir, { recursive: true });
      } catch {
        /* 目录已存在或无权限，交给 docker 处理 */
      }
    }

    const mounts = hostDir ? [{ source: hostDir, target: workdir }] : [];
    let res = await createContainer({ name, image, workdir, mounts });
    if (res.code !== 0 && mounts.length > 0) {
      // 挂载失败（路径对 daemon 不可见等）时退化为容器内部目录，保证任务仍可运行
      await removeContainer(name).catch(() => undefined);
      res = await createContainer({ name, image, workdir, mounts: [] });
    } else if (res.code === 0) {
      mounted = mounts.length > 0;
    }
    if (res.code !== 0) {
      throw new Error(
        `创建容器失败：${(res.stderr || res.stdout || "未知错误").trim().slice(0, 500)}`,
      );
    }

    const now = Date.now();
    const info: SandboxInfo = {
      id,
      name,
      image,
      createdAt: now,
      lastActivityAt: now,
      label: opts.label,
      role: opts.role ?? "main",
      parentId: opts.parentId,
      hostDir: mounted ? hostDir : undefined,
      mounted,
    };
    sandboxes.set(id, info);
    return new Sandbox(info);
  }

  /** 取回仍在注册表中的沙箱并刷新活动时间；不存在时返回 undefined。 */
  static async get(id: string): Promise<Sandbox | undefined> {
    const info = sandboxes.get(id);
    if (!info) return undefined;
    touchSandbox(id);
    return new Sandbox(info);
  }

  /** 尽力恢复句柄（容器可能已被回收），不保证存在。 */
  static async attach(id: string): Promise<Sandbox> {
    const existing = sandboxes.get(id);
    if (existing) {
      touchSandbox(id);
      return new Sandbox(existing);
    }
    const info: SandboxInfo = {
      id,
      name: containerName(id),
      image: "unknown",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      role: "main",
    };
    return new Sandbox(info);
  }

  touch(): void {
    touchSandbox(this.info.id);
  }

  async exec(command: string, timeoutMs = 120000, signal?: AbortSignal): Promise<ExecOutcome> {
    this.touch();
    const res = await execInContainer(this.info.name, command, {
      workdir: WORKDIR,
      timeoutMs,
      signal,
    });
    return toOutcome(res);
  }

  async writeFile(filePath: string, content: string | Buffer): Promise<ExecOutcome> {
    this.touch();
    const target = sanitizePath(filePath, WORKDIR);
    const res = await writeFileInContainer(this.info.name, target, content);
    return toOutcome(res, `已写入 ${target}`);
  }

  async readFile(filePath: string): Promise<ExecOutcome> {
    this.touch();
    const target = sanitizePath(filePath, WORKDIR);
    const res = await readFileInContainer(this.info.name, target);
    return toOutcome(res);
  }

  async listFiles(dir?: string): Promise<ExecOutcome> {
    this.touch();
    const target = sanitizePath(dir ?? WORKDIR, WORKDIR);
    return toOutcome(await listFilesInContainer(this.info.name, target));
  }

  async destroy(): Promise<void> {
    await removeContainer(this.info.name).catch(() => undefined);
    sandboxes.delete(this.info.id);
  }
}

export function toOutcome(res: RunResult, successMessage?: string): ExecOutcome {
  const ok = res.code === 0 && !res.timedOut;
  const parts: string[] = [];
  if (res.stdout.trim()) parts.push(res.stdout.trim());
  if (res.stderr.trim()) parts.push(`[stderr]\n${res.stderr.trim()}`);
  if (!res.stdout.trim() && !res.stderr.trim()) parts.push(successMessage ?? "(无输出)");
  if (res.code !== 0) parts.push(`退出码：${res.code}`);
  return { ok, output: truncate(parts.join("\n")) };
}

export function truncate(text: string, max = 12000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n…（已省略 ${text.length - max} 字符）…\n${text.slice(text.length - tail)}`;
}
