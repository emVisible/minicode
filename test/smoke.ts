// 端到端冒烟测试: 脚本化假 LLM server 驱动完整链路, 不依赖真实网络
// 验证: 配置加载 / LLM SSE 流式聚合 / 会话持久化

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LLMClient } from "../src/llm.ts"
import { loadConfig, saveConfig, applyConfigToEnv, configPath, switchProvider, activeProvider, listProviders, saveProviderProfile, resetForcedEnv, registerForcedEnv, DEFAULT_PROVIDER } from "../src/config.ts"
import { saveSession, listSessions, loadSession, deleteSession, renameSession, forkSession, newSessionId, latestSession, sessionsDirPath, setArchived } from "../src/session.ts"
import { recordUsage, sessionUsage, usageSummary, usageDetailLines, usageDayKey, flushUsage } from "../src/usage.ts"
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
  testUsage()
  await testHeadlessOutput()
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

  // ---------- 多 provider profile ----------
  saveConfig({ llmUrl: "http://legacy/v1", llmModel: "legacy-model" })
  check("无快照时列表只含 default", listProviders().names.length === 1 && listProviders().names[0] === DEFAULT_PROVIDER)
  check("无快照时当前为 default", activeProvider() === DEFAULT_PROVIDER)

  switchProvider("anthropic")
  check("切换后当前为 anthropic", activeProvider() === "anthropic" && listProviders().current === "anthropic")
  const after = loadConfig()
  check("新 provider 未配置时回退 legacy 顶层字段", after.llmUrl === "http://legacy/v1" && after.llmModel === "legacy-model")

  saveProviderProfile({ url: "https://api.anthropic.com/v1", apiKey: "sk-an", model: "claude-sonnet" })
  const switched = loadConfig()
  check("快照保存后当前 provider 生效", switched.llmUrl === "https://api.anthropic.com/v1" && switched.llmApiKey === "sk-an" && switched.llmModel === "claude-sonnet")

  switchProvider("default")
  const backTo = loadConfig()
  check("切回 default 保留 legacy 字段", backTo.llmUrl === "http://legacy/v1" && backTo.llmModel === "legacy-model" && backTo.llmApiKey === undefined)
  check("provider 列表含两个", listProviders().names.length === 2 && listProviders().names.includes("anthropic"))

  const userEnv = process.env.LLM_URL
  process.env.LLM_URL = "http://user-hard/v1"
  applyConfigToEnv(loadConfig())
  check("用户 env 恒优(不受配置注入影响)", process.env.LLM_URL === "http://user-hard/v1")
  resetForcedEnv()
  if (userEnv === undefined) delete process.env.LLM_URL
  process.env.LLM_URL = ""
  delete process.env.LLM_PROVIDER
  switchProvider(DEFAULT_PROVIDER)

  // ---------- v0.7 体验开关持久化 ----------
  saveConfig({ statusline: false, notify: false, contextLimit: 16000 })
  let v07 = loadConfig()
  check("v0.7 开关可持久化", v07.statusline === false && v07.notify === false && v07.contextLimit === 16000, JSON.stringify(v07))
  saveConfig({ statusline: true, notify: true })
  v07 = loadConfig()
  check("v0.7 开关回开后互不覆盖", v07.statusline === true && v07.notify === true && v07.contextLimit === 16000, JSON.stringify(v07))
  const def = loadConfig()
  saveConfig(def)
  check("loadConfig 顶层体验字段往返(保存后仍可读)", loadConfig().statusline === true && loadConfig().contextLimit === 16000)
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

  // 场景 7: 思考型模型(DeepSeek 系) —— 回答全程走 reasoning_content, content 为 null
  const s6 = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: "我们" } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: "需要思考" } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "", finish_reason: "stop" } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } })}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  })
  process.env.LLM_URL = `http://127.0.0.1:${s6.port}/v1`
  let thinkCollected = ""
  const r6 = await client.stream({
    messages: [{ role: "user", content: "x" }],
    onEvent: (e) => {
      if (e.type === "think-delta") thinkCollected += e.text
      if (e.type === "text-delta") thinkCollected += `[C]${e.text}`
    },
  })
  check("思考流(reasoning_content)解析", thinkCollected === "我们需要思考" && r6.message.content === "我们需要思考", `think="${thinkCollected}" content="${r6.message.content}"`)
  await s6.close()

  // 场景 8: 混合流 —— 先思考后正式回答, 落库只取 content
  const s7 = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: "思考中" } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "正式回答" } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  })
  process.env.LLM_URL = `http://127.0.0.1:${s7.port}/v1`
  let mixedThink = ""
  let mixedText = ""
  const r7 = await client.stream({
    messages: [{ role: "user", content: "x" }],
    onEvent: (e) => {
      if (e.type === "think-delta") mixedThink += e.text
      if (e.type === "text-delta") mixedText += e.text
    },
  })
  check("混合流思考与回答分流", mixedThink === "思考中" && mixedText === "正式回答", `think="${mixedThink}" text="${mixedText}"`)
  check("混合流落库只取 content", r7.message.content === "正式回答" && !r7.message.content.includes("思考中"), r7.message.content)
  await s7.close()
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

  renameSession(id, "我的任务A")
  const renamed = listSessions().find((s) => s.id === id)
  check("会话可重命名(title 写入且列表可见)", renamed?.title === "我的任务A", JSON.stringify(renamed?.title ?? null))

  const fork = forkSession(id)
  check("会话可分支(新 id, 内容保留)", fork !== null && fork.id !== id && fork.msgs.length === 3, fork ? `newId=${fork.id} msgs=${fork.msgs.length}` : "null")
  const forked = listSessions().some((s) => s.id === fork?.id)
  check("分支后可在列表出现", forked === true)

  deleteSession(id)
  check("会话可删除", listSessions().every((s) => s.id !== id))
  deleteSession(fork!.id)

  // ---------- v0.7 归档(可逆) ----------
  const aid = newSessionId("smoke")
  saveSession({
    id: aid,
    cwd: "/tmp",
    model: "mock",
    createdAt: 1700000000000,
    msgs: [{ kind: "user", text: "归档测试", ts: 1700000000000 }],
    history: [],
  })
  check("归档前列表可见且未标记", listSessions().find((s) => s.id === aid)?.archived === false)
  setArchived(aid, true)
  check("归档后标记生效", listSessions().find((s) => s.id === aid)?.archived === true)
  const latest2 = latestSession()
  check("归档后 --resume 不再选中它", latest2 === null || latest2.id !== aid)
  setArchived(aid, false)
  check("取消归档后恢复", listSessions().find((s) => s.id === aid)?.archived === false)
  deleteSession(aid)
}

// ---------- 用量账本 ----------

function testUsage(): void {
  flushUsage()
  const day = usageDayKey(1600000000000)
  recordUsage({ ts: 1600000000000, sessionId: "u1", model: "mock", inputTokens: 10, outputTokens: 20, latencyMs: 300 })
  recordUsage({ ts: 1600000000000, sessionId: "u1", model: "mock", inputTokens: 5, outputTokens: 30, latencyMs: 400 })
  recordUsage({ ts: 1600086400000, sessionId: "u2", model: "mock", inputTokens: 1, outputTokens: 99, latencyMs: 200 })
  const s = sessionUsage("u1")
  check("用量: 同会话累加", s !== undefined && s.turns === 2 && s.inputTokens === 15 && s.outputTokens === 50, JSON.stringify(s))
  const { today, days } = usageSummary()
  check("用量: 按天聚合(今日+历史)", days.some((d) => d.day === usageDayKey(1600000000000)), JSON.stringify(days))
  void today
  const lines = usageDetailLines("u1")
  check("用量: /usage 展示行包含会话累计", lines.some((l) => l.includes("2 轮")), lines.join("|"))
  flushUsage()
}

// ---------- headless 结构化输出(真子进程) ----------

import { spawn } from "node:child_process"

function runHeadless(env: Record<string, string | undefined>, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += String(d)))
    child.stderr.on("data", (d) => (stderr += String(d)))
    const t = setTimeout(() => child.kill("SIGKILL"), 30_000)
    child.on("close", (code) => {
      clearTimeout(t)
      resolve({ code, stdout, stderr })
    })
  })
}

async function testHeadlessOutput(): Promise<void> {
  const s = await serve((_req, res, _body) => {
    const e = sse(res)
    e.chunk("结构化回答")
    e.finish()
  })
  const env = { LLM_URL: `http://127.0.0.1:${s.port}/v1/chat/completions`, LLM_API_KEY: "", LLM_MODEL: "mock", LLM_PROVIDER: "" }
  const j = await runHeadless(env, ["--headless", "--json", "你好"])
  const parsed = JSON.parse(j.stdout.trim())
  check("headless --json: 单对象 + ok + 文本", parsed.ok === true && parsed.text === "结构化回答" && parsed.finish === "stop", j.stdout.slice(0, 200))
  check("headless --json: 退出码 0", j.code === 0, `code=${j.code}`)

  const st = await runHeadless(env, ["--headless", "--stream-json", "你好"])
  const lines = st.stdout.trim().split("\n").map((l) => JSON.parse(l))
  const types = lines.map((l) => l.type)
  check("headless --stream-json: delta→usage→done 顺序", types.includes("delta") && types[types.length - 1] === "done", types.join(","))
  check("headless --stream-json: 退出码 0", st.code === 0, `code=${st.code}`)

  const miss = await runHeadless({ ...env, LLM_URL: "", API_URL: "", MINICODE_CONFIG: "/dev/null" }, ["--headless", "--json", "hi"])
  let missObj: { ok?: boolean; exitCode?: number } | null = null
  try {
    missObj = JSON.parse(miss.stdout.trim())
  } catch {}
  check("headless --json: 未配置端点 → JSON error + 退出码 2", missObj?.ok === false && missObj?.exitCode === 2 && miss.code === 2, `code=${miss.code} out=${miss.stdout.slice(0, 120)}`)
  await s.close()
}

void main()