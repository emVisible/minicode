// 端到端冒烟测试: 脚本化假 LLM server 驱动完整链路, 不依赖真实网络
// 验证: 配置加载 / LLM SSE 流式聚合 / 会话持久化

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LLMClient } from "../src/llm.ts"
import { loadConfig, saveConfig, applyConfigToEnv, configPath } from "../src/config.ts"
import { saveSession, listSessions, loadSession, deleteSession, newSessionId, latestSession, sessionsDirPath } from "../src/session.ts"
import { homePath, configFile, ensureHome, sessionsDir } from "../src/paths.ts"
import type { ChatMessage } from "../src/types.ts"

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ""}`)
  }
}

// ---------- 假 LLM server ----------

interface MockServer {
  port: number
  close: () => Promise<void>
}

function serve(handler: (req: any, res: any, body: any) => void): Promise<MockServer> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        let body: any = {}
        try {
          body = JSON.parse(raw)
        } catch {
          body = {}
        }
        handler(req, res, body)
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as AddressInfo
      resolve({ port: a.port, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

/** 返回编写好的 SSE 响应助手 */
function sse(res: any): {
  chunk: (text: string) => void
  finish: () => void
} {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  return {
    chunk: (text) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
    finish: () => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    },
  }
}

// ---------- 环境隔离: 所有测试用独立 MINICODE_HOME ----------

const isoHome = mkdtempSync(join(tmpdir(), "smoke-home-"))

async function main(): Promise<void> {
  console.log("MiniCode smoke")
  try {
    await runIsolated()
  } finally {
    rmSync(isoHome, { recursive: true, force: true })
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

async function runIsolated(): Promise<void> {
  // 数据目录用 MINICODE_HOME 隔离(项目内缓存目录, 动态读取, 不受 HOME 影响)
  process.env.MINICODE_HOME = isoHome
  // 清掉可能干扰的 env(配置优先于 env 的测试依赖)
  process.env.LLM_URL = ""
  process.env.API_URL = ""
  process.env.LLM_API_KEY = ""
  process.env.LLM_MODEL = ""
  testPaths()
  testConfig()
  await testLLM()
  testSession()
}

// ---------- 路径解析(项目内缓存) ----------

function testPaths(): void {
  check("MINICODE_HOME 生效(数据目录)", homePath() === isoHome, homePath())
  check("配置/会话/日志在 MINICODE_HOME 下", configFile().startsWith(isoHome) && sessionsDir().startsWith(isoHome) && configPath().startsWith(isoHome))
  ensureHome()
  check("ensureHome 幂等创建目录", existsSync(isoHome))
}

// ---------- 配置 ----------

function testConfig(): void {
  const cfgPath = join(process.env.MINICODE_HOME!, "config.json")

  saveConfig({ llmUrl: "http://cfg.example/v1", llmApiKey: "k", llmModel: "m" })
  let file = ""
  try {
    file = readFileSync(cfgPath, "utf8")
  } catch {
    file = ""
  }
  check("配置原子写", file.length > 0, "文件未写入")
  check("配置写入后权限 0600", (() => {
    try {
      const mode = (statSync(cfgPath).mode & 0o777) as number
      return mode === 0o600
    } catch {
      return false
    }
  })(), "权限不是 0600")

  const back = loadConfig()
  check("配置往返一致", back.llmUrl === "http://cfg.example/v1" && back.llmApiKey === "k" && back.llmModel === "m")

  saveConfig({ llmUrl: "http://fromcfg/v1" })
  applyConfigToEnv(loadConfig())
  check("配置注入 env", process.env.LLM_URL === "http://fromcfg/v1")

process.env.LLM_URL = "http://direct/v1"
  applyConfigToEnv(loadConfig())
  check("env 优先于配置", process.env.LLM_URL === "http://direct/v1")

  writeFileSync(cfgPath, "{bad json", "utf8")
  check("损坏配置回退空", loadConfig().llmUrl === undefined)
}

// ---------- LLM 流式 ----------

async function testLLM(): Promise<void> {
  // 场景 1: SSE 流式分块聚合
  const s1 = await serve((_req, res, _body) => {
    const h = sse(res)
    h.chunk("你好")
    h.chunk("世界")
    h.chunk("!")
    h.finish()
  })
  process.env.LLM_URL = `http://127.0.0.1:${s1.port}/v1`
  process.env.LLM_MODEL = "mock"
  const client = new LLMClient()
  let collected = ""
  const res1 = await client.stream({
    messages: [{ role: "user", content: "hi" }],
    onEvent: (e) => {
      if (e.type === "text-delta") collected += e.text
    },
  })
  check("SSE 流式聚合文本", collected === "你好世界!" && res1.message.content === "你好世界!", `got "${collected}"`)
  check("finish=stop 且 usage 计数", res1.finish === "stop" && res1.usage.totalTokens === 30)
  await s1.close()

  // 场景 2: 多轮上下文回传(消息数组传递正确)
  const s2 = await serve((_req, res, body) => {
    const h = sse(res)
    h.chunk(`你发了 ${body.messages.length} 条`)
    h.finish()
  })
  process.env.LLM_URL = `http://127.0.0.1:${s2.port}/v1`
  const res2 = await client.stream({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ] as ChatMessage[],
  })
  check("多轮消息上下文传递", res2.message.content === "你发了 4 条", res2.message.content)
  await s2.close()

  // 场景 3: 500 错误后退避重试成功
  let calls = 0
  const s3 = await serve((_req, res) => {
    calls++
    if (calls === 1) {
      res.writeHead(500, { "content-type": "application/json" }).end("{}")
      return
    }
    const h = sse(res)
    h.chunk("重试成功")
    h.finish()
  })
  process.env.LLM_URL = `http://127.0.0.1:${s3.port}/v1`
  let retryText = ""
  const r3 = await client.stream({
    messages: [{ role: "user", content: "x" }],
    onEvent: (e) => {
      if (e.type === "text-delta") retryText += e.text
    },
  })
  check("500 后退避重试", calls === 2 && retryText === "重试成功" && r3.finish === "stop", `calls=${calls} text="${retryText}"`)
  await s3.close()

  // 场景 4: 非流式 JSON 返回兼容
  const s4 = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "JSON答复" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }))
  })
  process.env.LLM_URL = `http://127.0.0.1:${s4.port}/v1`
  const r4 = await client.stream({ messages: [{ role: "user", content: "x" }] })
  check("非流式 JSON 返回兼容", r4.message.content === "JSON答复" && r4.finish === "stop")
  await s4.close()

  // 场景 5: 未配置端点报错
  process.env.LLM_URL = ""
  const e1 = await client.stream({ messages: [{ role: "user", content: "x" }] }).catch((e: Error) => e)
  check("未配置端点报错", e1 instanceof Error && /LLM_URL/.test(String(e1.message)), String(e1))

  // 场景 6: AbortSignal 中断
  const s5 = await serve((_req, res) => {
    // 不响应, 挂起; 由 AbortSignal 中断
  })
  process.env.LLM_URL = `http://127.0.0.1:${s5.port}/v1`
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  const e2 = await client.stream({ messages: [{ role: "user", content: "x" }], signal: ac.signal }).catch((e: Error) => e)
  check("AbortSignal 中断请求", e2 instanceof Error && /中断/.test(String(e2.message)), String(e2))
  await s5.close()
}

// ---------- 会话持久化 ----------

function testSession(): void {
  const id = newSessionId("smoke")
  saveSession({
    id,
    cwd: "/tmp",
    model: "mock",
    createdAt: 1700000000000,
    msgs: [
      { kind: "user", text: "你好", ts: 1700000000000 },
      { kind: "assistant", text: "你好!", ts: 1700000001000 },
      { kind: "verdict", ok: true, text: "完成", ts: 1700000002000 },
    ],
    history: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好!" },
    ],
  })
  const list = listSessions()
  check("会话已保存并可列出", list.length >= 1 && list[0]!.firstMsg === "你好", JSON.stringify(list[0] ?? null))

  const rec = loadSession(id)
  check("会话可加载(msgs+history)", rec !== null && rec.msgs.length === 3 && rec.history.length === 2, rec ? `msgs=${rec.msgs.length}` : "null")

  const latest = latestSession()
  check("会话可恢复最近", latest !== null && latest.id === id)

  deleteSession(id)
  check("会话可删除", listSessions().every((s) => s.id !== id))
}

void main()