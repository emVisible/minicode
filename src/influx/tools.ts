// Influx 工具层: 内置工具注册表
// 内置: http.get / http.post / shell / write-file / read-file / list-dir / llm
// 自定义工具: 计划文件通过 registerTool 注册, MCP 会话与 spec 计划同样可用

import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { Agent, request as uRequest } from "undici"
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
  async ({ url, headers, timeoutMs = 30000 }) => {
    if (!url) throw new Error("[http.get] 缺少 url")
    return request("GET", { url, headers, timeoutMs })
  },
  "GET 远端 API, 参数: url(必填), headers, timeoutMs; 返回 {status, headers, body}",
)

registerTool(
  "http.post",
  async ({ url, headers, body, timeoutMs = 30000 }) => {
    if (!url) throw new Error("[http.post] 缺少 url")
    return request("POST", { url, headers, body, timeoutMs })
  },
  "POST 远端 API, 参数: url(必填), headers, body, timeoutMs; 返回 {status, headers, body}",
)

async function request(
  method: string,
  { url, headers, body, timeoutMs }: { url: string; headers?: Record<string, string>; body?: unknown; timeoutMs: number },
) {
  const res = await uRequest(url, {
    method,
    headers: { "user-agent": "influx/0.3", ...(headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: agent,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.body.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // 非 JSON 响应保持原文
  }
  if (res.statusCode >= 400) throw new Error(`[http] ${method} ${url} -> ${res.statusCode} ${truncate(text, 200)}`)
  return { status: res.statusCode, headers: res.headers as Record<string, string>, body: parsed }
}

// ---------- 本地 shell ----------

const exec = promisify(execCb)

registerTool(
  "shell",
  async ({ cmd, timeoutMs = 30000 }) => {
    if (!cmd) throw new Error("[shell] 缺少 cmd")
    const { stdout, stderr } = await exec(cmd, { timeout: timeoutMs })
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 }
  },
  "执行本地 shell 命令, 参数: cmd(必填), timeoutMs; 返回 {stdout, stderr, exitCode}",
)

// ---------- 本地文件系统 ----------

registerTool(
  "write-file",
  async ({ path, content = "", append = false }, ctx) => {
    const { mkdirSync, writeFileSync, appendFileSync, statSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    if (!path) throw new Error("[write-file] 缺少 path")
    // VBuild 模式: 写入内存 overlay, RBuild 统一落盘
    if (ctx.vfs) {
      const abs = ctx.vfs.abs(path)
      if (append) {
        const prev = ctx.vfs.has(abs) ? ctx.vfs.read(abs) : ""
        ctx.vfs.write(abs, prev + content)
      } else {
        ctx.vfs.write(abs, content)
      }
      return { ok: true, path, bytes: Buffer.byteLength(content), append, vbuild: true }
    }
    mkdirSync(dirname(path), { recursive: true })
    if (append) appendFileSync(path, content, "utf8")
    else writeFileSync(path, content, "utf8")
    return { ok: true, path, bytes: statSync(path).size, append }
  },
  "写文件(自动建目录), 参数: path(必填), content, append; 返回 {ok, path, bytes}; VBuild 模式下写入内存 overlay",
)

registerTool(
  "read-file",
  async ({ path }, ctx) => {
    const { readFileSync, existsSync, statSync } = await import("node:fs")
    if (!path) throw new Error("[read-file] 缺少 path")
    // VBuild 模式: 优先读 overlay(构建中的世界)
    if (ctx.vfs) {
      const abs = ctx.vfs.abs(path)
      if (ctx.vfs.has(abs)) {
        const content = ctx.vfs.read(abs)
        return { exists: true, path: abs, content, bytes: Buffer.byteLength(content), vbuild: true }
      }
      return { exists: false, path: abs, vbuild: true }
    }
    if (!existsSync(path)) return { exists: false, path }
    return { exists: true, path, content: readFileSync(path, "utf8"), bytes: statSync(path).size }
  },
  "读文件, 参数: path(必填); 返回 {exists, path, content, bytes}; VBuild 模式下读 overlay",
)

registerTool(
  "list-dir",
  async ({ path, recursive = false }) => {
    const { readdirSync } = await import("node:fs")
    const { join } = await import("node:path")
    if (!path) throw new Error("[list-dir] 缺少 path")
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
    scan(path, "")
    return { root: path, files, dirs }
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
  async ({ prompt, system, model, temperature = 0.2, url, timeoutMs = 120000, tools, maxSteps }, ctx) => {
    if (!prompt) throw new Error("[llm] 缺少 prompt")
    const client = createLLMClient({ endpoint: url ? resolveEndpoint(url) : undefined, timeoutMs })

    // agent 模式: 计划节点内嵌完整 agent 循环(tool_calls)
    if (tools?.length) {
      const loop = await getAgentLoop()
      return loop({ prompt, system, model, temperature, url, timeoutMs, tools, maxSteps, ctx })
    }

    // 单问模式: 复用与对话侧完全相同的流式客户端; 流式 delta 转发给 UI(thinking 过程)
    const res = await client.stream({
      messages: [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        { role: "user" as const, content: prompt },
      ],
      tools: [],
      model,
      temperature,
      onEvent: (e) => {
        if (e.type === "text-delta" && ctx.onStream) ctx.onStream("llm", e.text)
      },
    })
    if (res.message.tool_calls?.length) throw new Error("[llm] 意外收到 tool_calls(未传 tools)")
    return { answer: res.message.content }
  },
  "LLM 节点(OpenAI 兼容 chat/completions, 与对话侧共用 LLMClient)。参数: prompt(必填), system, model, temperature, url, timeoutMs; 传 tools(数组, 内置 agent 工具名) 则进入 agent 模式, 节点内跑 tool-call 回环并返回 {answer, steps, finish}; 否则返回 {answer}",
)

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
