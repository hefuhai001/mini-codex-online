import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

const MODE = (process.env.DOCKER_MODE ?? "wsl").toLowerCase();
const WSL_DISTRO = process.env.WSL_DISTRO ?? "";
const DOCKER_BIN = process.env.DOCKER_BIN ?? "docker";
const FALLBACK_WSL = "C:\\Windows\\System32\\wsl.exe";
const MAX_BUFFER = 2_000_000;

// 默认通过本机 2375 端口的 Docker daemon 通信
const DOCKER_HOST = (process.env.DOCKER_HOST ?? "tcp://localhost:2375").trim();
// WSL 模式下可单独覆盖（WSL 内访问 Windows 端口可能不是 localhost）
const WSL_DOCKER_HOST = (process.env.WSL_DOCKER_HOST ?? "").trim();

export function dockerHost(): string {
  return MODE === "wsl" ? WSL_DOCKER_HOST || DOCKER_HOST : DOCKER_HOST;
}

let resolvedWsl: string | null = null;

function wslExecutable(): string {
  if (resolvedWsl) return resolvedWsl;
  resolvedWsl = process.env.WSL_EXE?.trim() || "wsl.exe";
  return resolvedWsl;
}

function buildCommand(argv: string[]): { file: string; args: string[] } {
  const host = dockerHost();
  const dockerArgs = host ? ["-H", host, ...argv] : argv;
  if (MODE === "wsl") {
    const args: string[] = [];
    if (WSL_DISTRO) args.push("-d", WSL_DISTRO);
    args.push("--", DOCKER_BIN, ...dockerArgs);
    return { file: wslExecutable(), args };
  }
  return { file: DOCKER_BIN, args: dockerArgs };
}

export interface RunOptions {
  input?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 执行一次命令（默认经由 WSL 调用 docker）。 */
export function runCommand(
  argv: string[],
  opts: RunOptions = {},
  allowFallback = true,
): Promise<RunResult> {
  const { file, args } = buildCommand(argv);
  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(
        /*turbopackIgnore: true*/ file,
        args,
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, opts.timeoutMs)
        : null;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (
        allowFallback &&
        MODE !== "host" &&
        (err.code === "ENOENT" || err.code === "EINVAL") &&
        wslExecutable() !== FALLBACK_WSL
      ) {
        resolvedWsl = FALLBACK_WSL;
        runCommand(argv, opts, false).then(resolve, reject);
        return;
      }
      if (settled) return;
      settled = true;
      reject(err);
    });

    child.on("close", (code) => {
      finish({
        code: code ?? -1,
        stdout,
        stderr: timedOut
          ? `${stderr}\n[执行超过 ${opts.timeoutMs ?? 0}ms，已被终止]`.trim()
          : stderr,
        timedOut,
      });
    });

    try {
      if (opts.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    } catch {
      /* ignore */
    }
  });
}

function docker(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runCommand(argv, opts);
}

/** 判断 Docker 是否可用，返回版本号或错误信息。 */
export async function dockerStatus(): Promise<{
  ok: boolean;
  version?: string;
  host?: string;
  error?: string;
}> {
  const host = dockerHost();
  const res = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30000 });
  const version = res.stdout.trim();
  if (res.code === 0 && version) return { ok: true, version, host };
  return {
    ok: false,
    host,
    error: `${(res.stderr || res.stdout || "无法连接 Docker").trim().slice(0, 400)}\n（DOCKER_HOST=${host}）`,
  };
}

/** 创建并后台保活一个临时容器。 */
export async function createContainer(opts: {
  name: string;
  image: string;
  workdir: string;
}): Promise<RunResult> {
  const res = await docker(
    [
      "run",
      "-d",
      "--name",
      opts.name,
      "-w",
      opts.workdir,
      opts.image,
      "sh",
      "-c",
      "while true; do sleep 3600; done",
    ],
    { timeoutMs: 600000 },
  );
  if (res.code === 0) {
    await docker(["exec", "-w", "/", opts.name, "mkdir", "-p", opts.workdir], {
      timeoutMs: 60000,
    });
  }
  return res;
}

export async function removeContainer(name: string): Promise<RunResult> {
  return docker(["rm", "-f", name], { timeoutMs: 120000 });
}

export async function execInContainer(
  name: string,
  command: string,
  opts: { workdir?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return docker(
    ["exec", "-w", opts.workdir ?? "/", name, "sh", "-c", command],
    { timeoutMs: opts.timeoutMs ?? 120000, signal: opts.signal },
  );
}

/** 通过 stdin 把内容写入容器内的文件（二进制安全）。 */
export async function writeFileInContainer(
  name: string,
  filePath: string,
  content: string | Buffer,
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "/";
  const script = `mkdir -p '${dir || "/"}' && cat > '${filePath}'`;
  return docker(["exec", "-i", "-w", "/", name, "sh", "-c", script], {
    input: content,
    timeoutMs: opts.timeoutMs ?? 120000,
  });
}

export async function readFileInContainer(
  name: string,
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return docker(["exec", "-w", "/", name, "sh", "-c", `cat '${filePath}'`], {
    timeoutMs: opts.timeoutMs ?? 60000,
  });
}

export async function listFilesInContainer(
  name: string,
  dir: string,
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  return docker(["exec", "-w", dir, name, "sh", "-c", "ls -lah"], {
    timeoutMs: opts.timeoutMs ?? 60000,
  });
}

/** 规范化容器内路径，避免破坏 shell 引用。 */
export function sanitizePath(input: string, baseDir = "/workspace"): string {
  let clean = (input ?? "").trim().replace(/['"`\\\r\n]/g, "");
  if (!clean) return baseDir;
  if (!clean.startsWith("/")) clean = `${baseDir}/${clean.replace(/^\.\/+/, "")}`;
  clean = clean.replace(/\/{2,}/g, "/");
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean;
}
