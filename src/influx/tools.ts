// Influx 工具层: 内置工具注册表
// 内置: http.get / http.post / shell / write-file / read-file / list-dir / llm
// 自定义工具: 计划文件通过 registerTool 注册, MCP 会话与 spec 计划同样可用

import { Agent, request as uRequest } from "undici"
import { resolve } from "node:path"
import type { ToolCtx } from "./core.ts"
import { createLLMClient, resolveEndpoint } from "../llm.ts"

type ToolImpl = (params: Record<string, any>, ctx: ToolCtx) => Promise<unknown>

const registry = new Map<string, { fn: ToolImpl; desc?: string }>()

// 默认 fetch 每个 origin 单条连接, 并发会被排队; 显式扩容连接池才能让 HTTP 并行
const agent = new Agent({ connections: 16 })

export function registerTool(name: string, fn: ToolImpl, desc?: string): void {
  registry.set(name, { fn, desc })
}

export function getTool(name: string): ToolImpl {
  const t = registry.get(name)
  if (!t) throw new Error(`[influx] 工具未注册: ${name}`)
  return t.fn
}

export function listTools(): Array<{ name: string; desc?: string }> {
  return [...registry.entries()].map(([name, t]) => ({ name, desc: t.desc }))
}

// ---------- 远端 HTTP ----------

registerTool(
  "http.get",
  async (params, ctx) => {
    const { url, headers, timeoutMs = 30000 } = params
    if (!url) throw new Error(`[http.get] 缺少 url (节点 ${ctx.key}, 参数: ${truncate(JSON.stringify(params), 200)})`)
    return request("GET", { url, headers, timeoutMs }, ctx.signal)
  },
  "GET 远端 API, 参数: url(必填), headers, timeoutMs; 返回 {status, headers, body}",
)

registerTool(
  "http.post",
  async (params, ctx) => {
    const { url, headers, body, timeoutMs = 30000 } = params
    if (!url) throw new Error(`[http.post] 缺少 url (节点 ${ctx.key}, 参数: ${truncate(JSON.stringify(params), 200)})`)
    return request("POST", { url, headers, body, timeoutMs }, ctx.signal)
  },
  "POST 远端 API, 参数: url(必填), headers, body, timeoutMs; 返回 {status, headers, body}",
)

async function request(
  method: string,
  { url, headers, body, timeoutMs }: { url: string; headers?: Record<string, string>; body?: unknown; timeoutMs: number },
  signal?: AbortSignal,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const res = await uRequest(url, {
    method,
    headers: { "user-agent": "influx/0.3", ...(headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: agent,
    signal: combined,
  })
  const text = await res.body.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // 非 JSON 响应保持原文
  }
  if (res.statusCode >= 400) throw new Error(`[http] ${method} ${url} -> ${res.statusCode} ${truncate(text, 200)}`)
  return { status: res.statusCode, headers: res.headers as Record<string, string>, body: parsed, output: typeof parsed === "string" ? parsed : JSON.stringify(parsed) }
}

// ---------- 本地 shell ----------

import { runCommandStreaming, runCommandError } from "../exec-stream.ts"

registerTool(
  "shell",
  async (params, ctx) => {
    const cmd = params.cmd
    if (!cmd) {
      // 空 cmd 常见根因: 模型写了 {$k.output} 模板引用, 但引用的 key 不存在/输出为空 → 解析成空串。
      // 用原始参数回看模板, 直接告诉用户问题出在哪。
      const raw = ctx.rawParams?.cmd
      const templateRef = typeof raw === "string" && raw.includes("{$") ? raw : undefined
      throw new Error(
        templateRef
          ? `[shell] cmd 解析为空 (节点 ${ctx.key}): 模板 "${templateRef.slice(0, 120)}" 引用的节点输出为空或 key 不存在`
          : `[shell] 缺少 cmd (节点 ${ctx.key}, 收到参数: ${truncate(JSON.stringify(params), 200)})`,
      )
    }
    const timeoutMs = params.timeoutMs ?? 30000
    // VBuild 模式: shell 读真实磁盘, 先把暂存的创建/修改刷到磁盘(如 bash fix.sh 依赖前序 write-file)
    ctx.vfs?.flushToDisk()
    // 流式执行: stdout/stderr 逐 chunk 实时转发给 UI —— 长命令不再"零信息运行"
    const key = ctx.key ?? "shell"
    const r = await runCommandStreaming({
      cmd,
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      onChunk: (text) => {
        // 限流: 每 chunk ≤ 500 字符, 防止高频输出把 UI 刷爆
        ctx.onStream?.(key, text.length > 500 ? text.slice(-500) + "\n…" : text)
      },
    })
    if (r.code !== 0) throw runCommandError(r, cmd)
    const out = r.stdout.trim()
    return { stdout: out, stderr: r.stderr.trim(), exitCode: 0, output: out }
  },
  "执行本地 shell 命令, 参数: cmd(必填), timeoutMs; 返回 {stdout, stderr, exitCode, output}",
)

// ---------- 本地文件系统 ----------

registerTool(
  "write-file",
  async (params, ctx) => {
    const { mkdirSync, writeFileSync, appendFileSync, statSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    const { path, content = "", append = false } = params
    if (!path) throw new Error(`[write-file] 缺少 path (节点 ${ctx.key}, 参数: ${truncate(JSON.stringify(params), 200)})`)
    // VBuild 模式: 写入内存 overlay, RBuild 统一落盘
    if (ctx.vfs) {
      const abs = ctx.vfs.abs(path)
      if (append) {
        const prev = ctx.vfs.has(abs) ? ctx.vfs.read(abs) : ""
        ctx.vfs.write(abs, prev + content)
      } else {
        ctx.vfs.write(abs, content)
      }
      return { ok: true, path: abs, bytes: Buffer.byteLength(content), append, vbuild: true, output: content }
    }
    const abs = resolvePath(ctx.cwd, path)
    mkdirSync(dirname(abs), { recursive: true })
    if (append) appendFileSync(abs, content, "utf8")
    else writeFileSync(abs, content, "utf8")
    // 真实写入后作废预取缓存(防止后续 read-file 命中过期内容)
    ctx.prefetch?.invalidate(abs)
    return { ok: true, path: abs, bytes: statSync(abs).size, append, output: content }
  },
  "写文件(自动建目录), 参数: path(必填), content, append; 返回 {ok, path, bytes, output}; VBuild 模式下写入内存 overlay",
)

// 相对 ctx.cwd 解析路径(与对话侧 read/write 一致)
function resolvePath(cwd: string, p: string): string {
  return resolve(cwd, p)
}

registerTool(
  "read-file",
  async (params, ctx) => {
    const { readFileSync, existsSync, statSync } = await import("node:fs")
    const { path } = params
    if (!path) throw new Error(`[read-file] 缺少 path (节点 ${ctx.key}, 参数: ${truncate(JSON.stringify(params), 200)})`)
    // VBuild 模式: 优先读 overlay(构建中的世界)
    if (ctx.vfs) {
      const abs = ctx.vfs.abs(path)
      if (ctx.vfs.has(abs)) {
        const content = truncateFile(ctx.vfs.read(abs), abs)
        return { exists: true, path: abs, content, output: content, bytes: Buffer.byteLength(content), vbuild: true, truncated: content.length < ctx.vfs.read(abs).length }
      }
      return { exists: false, path: abs, output: "", vbuild: true }
    }
    const abs = resolvePath(ctx.cwd, path)
    // 预测式预取命中: 该文件在本波开始前已被后台预读(上一波执行期间)
    const cached = ctx.prefetch?.get(abs)
    if (cached !== undefined) {
      const content = truncateFile(cached, abs)
      return { exists: true, path: abs, content, output: content, bytes: Buffer.byteLength(content), prefetched: true, truncated: content.length < cached.length }
    }
    if (!existsSync(abs)) return { exists: false, path: abs, output: "" }
    const full = readFileSync(abs, "utf8")
    const content = truncateFile(full, abs)
    return { exists: true, path: abs, content, output: content, bytes: statSync(abs).size, truncated: content.length < full.length }
  },
  "读文件, 参数: path(必填); 返回 {exists, path, content, output, bytes}; VBuild 模式下读 overlay; 超 50KB 截断(truncated)",
)

// read-file 输出截断(对齐对话侧 read 的 50KB 上限, 防止大文件撑爆 {$k.output} 引用与 llm 节点上下文)
function truncateFile(content: string, path: string): string {
  const MAX = 50 * 1024
  if (content.length <= MAX) return content
  return content.slice(0, MAX) + `\n...(输出过长已截断, 共 ${content.length} 字符, 文件: ${path})`
}

registerTool(
  "list-dir",
  async (params, ctx) => {
    const { readdirSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { path, recursive = false } = params
    if (!path) throw new Error(`[list-dir] 缺少 path (节点 ${ctx.key}, 参数: ${truncate(JSON.stringify(params), 200)})`)
    const root = resolvePath(ctx.cwd, path)
    const files: string[] = []
    const dirs: string[] = []
    const scan = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(prefix + entry.name)
          if (recursive) scan(join(dir, entry.name), prefix + entry.name + "/")
        } else {
          files.push(prefix + entry.name)
        }
      }
    }
    scan(root, "")
    return { root, files, dirs }
  },
  "列出目录, 参数: path(必填), recursive; 返回 {root, files, dirs}",
)

// ---------- LLM 智能节点 ----------
// 统一使用 src/llm.ts 的 LLMClient(与对话侧同一实现: SSE 流式/重试/超时/中断)。
// 两种模式:
//   1. 单问模式(默认): 一次 prompt 得到 {answer}
//   2. agent 模式: 传 tools 数组, 节点内跑完整 tool-call 回环(计划内嵌对话)

let agentLoop: ((opts: {
  prompt: string
  system?: string
  model?: string
  temperature?: number
  url?: string
  timeoutMs?: number
  tools: string[]
  maxSteps?: number
  ctx: ToolCtx
}) => Promise<unknown>) | null = null

// 延迟加载, 避免与 src/tools.ts 形成循环依赖(对话工具注册表引用本模块的 getTool)
async function getAgentLoop() {
  if (!agentLoop) {
    const mod = await import("./agent-loop.ts")
    agentLoop = mod.runAgentLoop
  }
  return agentLoop
}

registerTool(
  "llm",
  async (params, ctx) => {
    const { prompt, system, model, temperature = 0.2, url, timeoutMs = 120000, tools, maxSteps } = params
    if (!prompt) throw new Error(`[llm] 缺少 prompt (节点 ${ctx.key}, 参数: ${truncate(JSON.stringify(params), 200)})`)
    const client = createLLMClient({ endpoint: url ? resolveEndpoint(url) : undefined, timeoutMs })

    // agent 模式: 计划节点内嵌完整 agent 循环(tool_calls)
    if (tools?.length) {
      const loop = await getAgentLoop()
      return loop({ prompt, system, model, temperature, url, timeoutMs, tools, maxSteps, ctx })
    }

    // 单问模式: 复用与对话侧完全相同的流式客户端; 流式 delta 转发给 UI(thinking 过程)
    // 用节点 key 区分多个 llm 节点的流(并行 llm 不串流)
    const key = ctx.key ?? "llm"
    const res = await client.stream({
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        { role: "user" as const, content: prompt },
      ],
      tools: [],
      model,
      temperature,
      signal: ctx.signal,
      onEvent: (e) => {
        if (e.type === "text-delta" && ctx.onStream) ctx.onStream(key, e.text)
      },
    })
    if (res.message.tool_calls?.length) throw new Error("[llm] 意外收到 tool_calls(未传 tools)")
    return { answer: res.message.content, output: res.message.content }
  },
  "LLM 节点(OpenAI 兼容 chat/completions, 与对话侧共用 LLMClient)。参数: prompt(必填), system, model, temperature, url, timeoutMs; 传 tools(数组, 内置 agent 工具名) 则进入 agent 模式, 节点内跑 tool-call 回环并返回 {answer, steps, finish}; 否则返回 {answer, output}",
)

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
