# Mini Codex

一个最小可用的 Codex 形态代理：生成任务计划 → 派发子代理 → 在 **WSL 里的 Docker 临时容器**中执行脚本，并支持把本地文件上传进容器。

## 快速开始

```bash
pnpm install
cp .env.example .env.local   # 可选：填写模型地址/Key，也可以在界面里填
pnpm dev
```

打开 http://localhost:3000 ，先点右上角「设置」填写模型接口（Base URL / API Key / 模型），然后直接描述任务。

> 模型配置保存在浏览器 localStorage；`.env.local` 作为服务端的兜底默认值。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OPENAI_BASE_URL` | OpenAI 兼容接口地址 | 空 |
| `OPENAI_API_KEY` | 接口密钥 | 空 |
| `OPENAI_MODEL` | 模型名 | `gpt-4o-mini` |
| `AGENT_LANGUAGE` | 回复语言：`zh-CN` / `auto` / `en`（界面「设置」可覆盖） | `zh-CN` |
| `DOCKER_HOST` | daemon 地址，默认本机 2375 端口 | `tcp://localhost:2375` |
| `DOCKER_MODE` | `wsl` 用 WSL 里的 docker CLI 连上面的地址；`host` 用本机 docker CLI | `wsl` |
| `WSL_DOCKER_HOST` | 仅 WSL 模式生效，覆盖 `DOCKER_HOST`（WSL 访问 Windows 端口不是 localhost 时用） | 空 |
| `WSL_DISTRO` | WSL 发行版名（`wsl -l -q` 查看），留空用默认发行版 | 空 |
| `WSL_EXE` | `wsl.exe` 路径，找不到时自动回退系统目录 | `wsl.exe` |
| `DOCKER_BIN` | docker 可执行文件在 WSL 内的路径 | `docker` |
| `SANDBOX_IMAGE` | 默认沙箱镜像 | `ubuntu:24.04` |
| `SANDBOX_WORKDIR` | 容器内工作目录 | `/workspace` |
| `SANDBOX_MOUNT` | 是否把容器工作目录挂载到宿主机（`0` 关闭） | `1` |
| `SANDBOX_HOST_WORKSPACE` | 挂载源目录，默认项目根目录下的 `workspace` | 空 |
| `SANDBOX_IDLE_TIMEOUT_MS` | 会话空闲多久后销毁对应容器 | `600000`（10 分钟，最小 30000） |

> Windows 上若没有安装 docker CLI，保持 `DOCKER_MODE=wsl` 即可：会用 WSL 里的 `docker -H tcp://localhost:2375` 连接本机 2375 端口的 daemon。

### 空闲自动回收

- 每个容器记录 `lastActivityAt`，服务端每 30 秒巡检一次，超过 `SANDBOX_IDLE_TIMEOUT_MS` 没有活动就 `docker rm -f`。
- 计入"活动"：发消息、代理的每次工具调用/每轮循环、文件上传、面板手动执行命令。
- 子代理容器会带动父容器刷新活动时间，避免长任务中主容器被误回收。
- 容器被回收后再次发消息会自动新建一个容器，界面右上角倒计时归零后会清空容器显示。

## 工作方式

1. **规划**：规划器根据需求输出 `summary / image / steps` 三段 JSON，右侧面板实时展示步骤状态。
2. **执行**：主代理在 `/workspace` 里通过 `exec` 跑脚本，用 `write_file / read_file / list_files` 操作文件，每步用 `update_step` 同步进度。
3. **派发子代理**：`dispatch_subagent` 会为子任务新建一个**独立容器**，子代理自行完成后销毁容器，只回传结论；同一轮里的多个派发会并行执行。
4. **文件上传**：输入框的 `＋` 或右侧面板的上传区，会把文件写入容器的 `/workspace/uploads`。
5. **产物落盘**：容器的 `/workspace` 默认挂载到项目根目录下的 `workspace/`，代理生成的脚本、报告等在宿主机直接可见；子代理各自挂载到 `workspace/.subagents/<id>/`。若挂载失败会自动退化为容器内目录并在面板提示。
5. **手动操作**：右侧面板可新建/销毁容器、手动执行命令。

所有容器命名 `mini-codex-<id>`，任务结束后保留以便查看产物，可手动销毁。

## 目录结构

```
app/
  api/chat/route.ts      SSE 流式代理主循环
  api/sandbox/route.ts   容器状态 / 创建 / 执行 / 销毁
  api/upload/route.ts    文件上传进容器
  components/            对话界面（工作区 / 消息 / 侧边面板 / 设置）
lib/
  agent.ts               规划、主代理循环、子代理派发、工具定义
  llm.ts                 OpenAI 兼容接口（流式 + function calling + 兜底解析）
  docker.ts              wsl/docker 命令封装
  sandbox.ts             沙箱生命周期
```
