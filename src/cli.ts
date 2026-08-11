// MiniCode 统一入口 —— 对话式 agent(纯聊天, 无工具)
//
//   minicode                              # 交互 TUI(聊天)
//   minicode --headless [prompt]          # headless 单轮对话

import { createLLMClient } from "./llm.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { loadConfig, applyConfigToEnv } from "./config.ts"
import { saveSession, loadSession, latestSession } from "./session.ts"
import { recordUsage, flushUsage } from "./usage.ts"
import { log, installCrashHandlers, logSessionStart, logSessionEnd } from "./log.ts"
import { homePath, ensureHome, configFile } from "./paths.ts"

interface CliFlags {
  headless: boolean
  model?: string
  cwd: string
  /** 启动时恢复最近一次会话 */
  resume: boolean
  /** --resume=<id> 指定会话; 缺省恢复最近 */
  resumeId?: string
  /** 本次运行归属的会话(id 为空表示 headless 一次性) */
  sessionId: string
  /** 指定 provider(--provider <名字>; 快照来源见 config.ts) */
  provider?: string
  /** --json: 单轮结果输出为单个 JSON 对象 */
  json: boolean
  /** --stream-json: 每事件输出一行 NDJSON */
  streamJson: boolean
}

/** 结构化输出格式 */
export type OutputFormat = "text" | "json" | "stream-json"

function parseArgs(argv: string[]): { flags: CliFlags; promptArgs: string[] } {
  const flags: CliFlags = { headless: false, cwd: process.cwd(), resume: false, sessionId: "headless", json: false, streamJson: false }
  const promptArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--headless") flags.headless = true
    else if (arg === "-r" || arg === "--resume") flags.resume = true
    else if (arg.startsWith("--resume=")) {
      flags.resume = true
      flags.resumeId = arg.slice("--resume=".length)
    }
    else if (arg === "--cwd") {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags.cwd = next
        i++
      }
    } else if (arg.startsWith("--cwd=")) flags.cwd = arg.slice("--cwd=".length)
    else if (arg.startsWith("--model=")) flags.model = arg.slice("--model=".length)
    else if (arg === "--provider") {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags.provider = next
        i++
      }
    } else if (arg.startsWith("--provider=")) flags.provider = arg.slice("--provider=".length)
    else if (arg === "--json") flags.json = true
    else if (arg === "--stream-json" || arg === "--stream") flags.streamJson = true
    else promptArgs.push(arg)
  }
  return { flags, promptArgs }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8").trim()
}

// ---------- 对话 ----------

interface TurnResult {
  finish: string
  text: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

/**
 * 单轮对话。fmt 决定 stdout 形态:
 *   text        —— 流式原文 + [finish=...] 收尾(默认)
 *   json        —— 结束后输出单对象 JSON(delta 不外露)
 *   stream-json — 每事件一行 NDJSON: {"type":"delta"|"finish"|"error", ...}
 */
async function runTurn(flags: CliFlags, userContent: string, history: import("./types.ts").ChatMessage[], fmt: OutputFormat = "text"): Promise<TurnResult> {
  const client = createLLMClient()
  const system = buildSystemPrompt({ cwd: flags.cwd })
  const messages: import("./types.ts").ChatMessage[] = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: userContent },
  ]
  let text = ""
  const total = Date.now()
  const model = flags.model ?? process.env.LLM_MODEL ?? "默认"
  const result = await client.stream({
    messages,
    onEvent: (e) => {
      if (e.type === "text-delta") {
        text += e.text
        if (fmt === "text") process.stdout.write(e.text)
        else if (fmt === "stream-json") process.stdout.write(`${JSON.stringify({ type: "delta", text: e.text })}\n`)
      }
    },
  })
  const latencyMs = Date.now() - total
  recordUsage({
    sessionId: flags.sessionId,
    model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    latencyMs,
  })
  if (fmt === "stream-json") {
    process.stdout.write(`${JSON.stringify({ type: "usage", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, latencyMs })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "done", finish: result.finish, text })}\n`)
  } else if (fmt === "json") {
    process.stdout.write(`${JSON.stringify({ ok: true, finish: result.finish, text, model, sessionId: flags.sessionId, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, latencyMs })}\n`)
  } else {
    process.stdout.write(`\n\n[finish=${result.finish}]\n`)
  }
  return { finish: result.finish, text, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, latencyMs }
}

async function main(): Promise<void> {
  // 日志体系: 崩溃兜底 + 会话生命周期记录
  installCrashHandlers()
  logSessionStart(process.argv.slice(2), process.cwd())
  const exitCode = await runMain()
  // 用量账本防抖 300ms, process.exit 前必须落盘, 否则最后一次记录丢失
  flushUsage()
  logSessionEnd(exitCode)
  process.exit(exitCode)
}

async function runMain(): Promise<number> {
  const argv = process.argv.slice(2)

  const { flags, promptArgs } = parseArgs(argv)
  // 结构化输出只对 headless 有意义(强制无 TUI 分支)
  if (flags.json || flags.streamJson) flags.headless = true

  // 缓存/配置目录: 项目内 .minicode/(可被 MINICODE_HOME 显式覆盖), 启动即确保存在
  if (!process.env.MINICODE_HOME) {
    process.env.MINICODE_HOME = homePath(flags.cwd)
  }
  ensureHome(flags.cwd)

  // 启动即加载用户配置: 填充未设置的环境变量(环境变量优先)
  // --provider: 映射为 LLM_PROVIDER(不改写配置文件; 用户自设 LLM_PROVIDER 恒优)
  if (flags.provider && !process.env.LLM_PROVIDER) process.env.LLM_PROVIDER = flags.provider
  applyConfigToEnv(loadConfig(flags.cwd))
  log.info("paths", "数据目录", { home: process.env.MINICODE_HOME, config: configFile(flags.cwd) })

  // 交互模式(默认): 启动 Ink TUI(启动前检测终端主题, 注入 App)
  // ink 要求 stdin 为 TTY(否则无法进入 raw mode 会直接抛错); 非 TTY(管道/CI/非交互 shell)
  // 时退化为一次性执行: 读取管道输入的 prompt 走 headless, 而不是崩溃。
  if (!flags.headless && process.stdin.isTTY && process.stdout.isTTY) {
    log.info("tui", "启动全屏 TUI")
    const { render } = await import("ink")
    const { default: App } = await import("./ui/app.tsx")
    const { createElement } = await import("react")
    const { detectTerminalTheme } = await import("./ui/theme.ts")
    // 杂散 console.* → 日志文件, 避免任何第三方输出打穿 alternate screen 污染 TUI
    const { patchConsoleToFile } = await import("./console-patch.ts")
    const restoreConsole = patchConsoleToFile()
    const theme = await detectTerminalTheme()
    const isTty = process.stdout.isTTY
    if (isTty) process.stdout.write("\x1b[?1049h")
    let restored = false
    const restore = (): void => {
      if (restored || !isTty) return
      restored = true
      process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l")
    }
    process.on("exit", restore)
    process.on("exit", restoreConsole)
    // 鼠标过滤代理 stdin: 剥离 SGR 鼠标序列(ink 会把它当文本打进输入框),
    // 其余字节原样转发; 鼠标事件经 onMouse 上抛(由 App 内部路由)
    let stdin: typeof process.stdin = process.stdin
    let mouseBus: import("./ui/mouse.tsx").MouseBus | undefined
    if (isTty) {
      const { createMouseFilterStdin } = await import("./ui/mouse.tsx")
      const created = createMouseFilterStdin(process.stdin, () => {})
      stdin = created.stdin as typeof process.stdin
      mouseBus = created.bus
      process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h")
    }
    const instance = render(
      createElement(App, { cwd: flags.cwd, theme: theme ?? undefined, resume: flags.resume, mouseBus }),
      { stdin: stdin as any, exitOnCtrlC: false },
    )
    await instance.waitUntilExit()
    restore()
    restoreConsole()
    log.info("tui", "TUI 退出")
    return 0
  }

  const rawPrompt = promptArgs.join(" ") || (process.stdin.isTTY ? "" : await readStdin())
  if (!rawPrompt) {
    if (flags.json || flags.streamJson) process.stdout.write(`${JSON.stringify({ ok: false, error: "未提供 prompt(可用管道: echo '...' | minicode --headless)", exitCode: 1 })}\n`)
    else console.error("未提供 prompt(可以用管道: echo '...' | minicode --headless)")
    return 1
  }

  log.info("headless", "启动", { prompt: rawPrompt.slice(0, 200) })

  // headless 续接: --resume 恢复会话历史再追问, 回答落回同一会话
  if (flags.resume) {
    const rec = flags.resumeId ? loadSession(flags.resumeId) : latestSession()
    if (!rec) {
      log.info("headless", "无可恢复会话")
      if (flags.json || flags.streamJson) process.stdout.write(`${JSON.stringify({ ok: false, error: flags.resumeId ? `会话不存在: ${flags.resumeId}` : "没有已保存的会话可恢复", exitCode: 1 })}\n`)
      else console.error(flags.resumeId ? `会话不存在: ${flags.resumeId}` : "没有已保存的会话可恢复")
      return 1
    }
    flags.sessionId = rec.id
    const fmt: OutputFormat = flags.json ? "json" : flags.streamJson ? "stream-json" : "text"
    const { text } = await runTurn(flags, rawPrompt, rec.history, fmt)
    const ts = Date.now()
    rec.msgs.push({ kind: "user", text: rawPrompt, ts })
    if (text) rec.msgs.push({ kind: "assistant", text, ts: Date.now() })
    rec.history.push({ role: "user", content: rawPrompt })
    if (text) rec.history.push({ role: "assistant", content: text })
    saveSession(rec)
    return 0
  }

  const fmt: OutputFormat = flags.json ? "json" : flags.streamJson ? "stream-json" : "text"
  await runTurn(flags, rawPrompt, [], fmt)
  return 0
}

main().catch((e) => {
  log.error("main", "致命错误", { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined })
  const msg = e instanceof Error ? e.message : String(e)
  // 退出码: 0 成功 / 1 一般失败(重试耗尽、网络、中断前) / 2 配置缺失(未设置 LLM_URL)
  const code = /未配置 LLM_URL|未配置端点/.test(msg) ? 2 : 1
  const flags = parseArgs(process.argv.slice(2)).flags
  if (flags.json || flags.streamJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: msg, exitCode: code, type: flags.streamJson ? "error" : undefined })}\n`)
  }
  console.error(`\n✗ ${msg}`)
  process.exit(code)
})