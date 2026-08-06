// Influx 工具层: 内置工具注册表
// 内置: http.get / http.post / shell / write-file / read-file / list-dir / llm
// 自定义工具: 计划文件通过 registerTool 注册, MCP 会话与 spec 计划同样可用

import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { Agent, request as uRequest } from "undici"
import type { ToolCtx } from "./core.ts"

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
  async ({ path, content = "", append = false }) => {
    const { mkdirSync, writeFileSync, appendFileSync, statSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    if (!path) throw new Error("[write-file] 缺少 path")
    mkdirSync(dirname(path), { recursive: true })
    if (append) appendFileSync(path, content, "utf8")
    else writeFileSync(path, content, "utf8")
    return { ok: true, path, bytes: statSync(path).size, append }
  },
  "写文件(自动建目录), 参数: path(必填), content, append; 返回 {ok, path, bytes}",
)

registerTool(
  "read-file",
  async ({ path }) => {
    const { readFileSync, existsSync, statSync } = await import("node:fs")
    if (!path) throw new Error("[read-file] 缺少 path")
    if (!existsSync(path)) return { exists: false, path }
    return { exists: true, path, content: readFileSync(path, "utf8"), bytes: statSync(path).size }
  },
  "读文件, 参数: path(必填); 返回 {exists, path, content, bytes}",
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
// 端点解析顺序: url 参数 > LLM_URL 环境变量(host 注入) > API_URL; 鉴权: LLM_API_KEY / API_KEY

registerTool(
  "llm",
  async ({ prompt, system, model, temperature = 0.2, url, timeoutMs = 120000 }) => {
    if (!prompt) throw new Error("[llm] 缺少 prompt")
    const base = url ?? process.env.LLM_URL ?? process.env.API_URL
    if (!base) throw new Error("[llm] 未配置 LLM_URL, 请传 url 参数或在 host 环境注入 LLM_URL")
    const endpoint = base.endsWith("/chat/completions") ? base : base.replace(/\/+$/, "") + "/chat/completions"
    const key = process.env.LLM_API_KEY ?? process.env.API_KEY
    const body = {
      model: model ?? process.env.LLM_MODEL ?? "gpt-4o-mini",
      temperature,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }
    const res = await request("POST", {
      url: endpoint,
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body,
      timeoutMs,
    })
    const content = (res.body as any)?.choices?.[0]?.message?.content
    if (typeof content !== "string") throw new Error("[llm] 响应缺少 choices[0].message.content")
    return { answer: content }
  },
  "LLM 生成节点(OpenAI 兼容 chat/completions), 参数: prompt(必填), system, model, temperature, url, timeoutMs; 返回 {answer}",
)

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
