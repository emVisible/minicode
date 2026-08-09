// MiniCode 统一入口 —— 对话式 agent(纯聊天, 无工具)
//
//   minicode                              # 交互 TUI(聊天)
//   minicode --headless [prompt]          # headless 单轮对话

import { createLLMClient } from "./llm.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { loadConfig, applyConfigToEnv } from "./config.ts"
import { log, installCrashHandlers, logSessionStart, logSessionEnd } from "./log.ts"
import { homePath, ensureHome, configFile } from "./paths.ts"

interface CliFlags {
  headless: boolean
  model?: string
  cwd: string
  /** 启动时恢复最近一次会话 */
  resume: boolean
}

function parseArgs(argv: string[]): { flags: CliFlags; promptArgs: string[] } {
  const flags: CliFlags = { headless: false, cwd: process.cwd(), resume: false }
  const promptArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--headless") flags.headless = true
    else if (arg === "-r" || arg === "--resume") flags.resume = true
    else if (arg === "--cwd") {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags.cwd = next
        i++
      }
    } else if (arg.startsWith("--cwd=")) flags.cwd = arg.slice("--cwd=".length)
    else if (arg.startsWith("--model=")) flags.model = arg.slice("--model=".length)
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

async function runTurn(flags: CliFlags, userContent: string, history: import("./types.ts").ChatMessage[]): Promise<void> {
  const client = createLLMClient()
  const system = buildSystemPrompt({ cwd: flags.cwd })
  const messages: import("./types.ts").ChatMessage[] = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: userContent },
  ]
  const result = await client.stream({
    messages,
    onEvent: (e) => {
      if (e.type === "text-delta") process.stdout.write(e.text)
    },
  })
  process.stdout.write(`\n\n[finish=${result.finish} ]\n`)
}

async function main(): Promise<void> {
  // 日志体系: 崩溃兜底 + 会话生命周期记录
  installCrashHandlers()
  logSessionStart(process.argv.slice(2), process.cwd())
  const exitCode = await runMain()
  logSessionEnd(exitCode)
  process.exit(exitCode)
}

async function runMain(): Promise<number> {
  const argv = process.argv.slice(2)

  const { flags, promptArgs } = parseArgs(argv)

  // 缓存/配置目录: 项目内 .minicode/(可被 MINICODE_HOME 显式覆盖), 启动即确保存在
  if (!process.env.MINICODE_HOME) {
    process.env.MINICODE_HOME = homePath(flags.cwd)
  }
  ensureHome(flags.cwd)

  // 启动即加载用户配置: 填充未设置的环境变量(环境变量优先)
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
      process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1006l")
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
      process.stdout.write("\x1b[?1000h\x1b[?1006h")
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
    console.error("未提供 prompt(可以用管道: echo '...' | minicode --headless)")
    return 1
  }

  log.info("headless", "启动", { prompt: rawPrompt.slice(0, 200) })
  await runTurn(flags, rawPrompt, [])
  return 0
}

main().catch((e) => {
  log.error("main", "致命错误", { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined })
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})