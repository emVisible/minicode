// MiniCode 统一入口 —— 对话式编码 agent + Influx 声明式计划运行时
//
//   minicode                              # 交互 TUI(对话 agent)
//   minicode --headless [prompt]          # headless 单轮对话
//   minicode plan run <plan.tsx>          # 执行计划 [--serial] [--rerun] [--max-iter=N]
//   minicode plan bench <plan.tsx>        # 串行/并行基准 [--max-iter=N]
//   minicode plan view <plan.tsx>         # 浏览器可视化 [--serial] [--max-iter=N] [--no-open]
//   minicode run|bench|view <plan.tsx>    # (兼容 influx 旧命令)
//   minicode mcp                          # MCP 服务器(编排工具)

import type { LoopEvent } from "./types.ts"
import { builtinTools } from "./tools.ts"
import { createLLMClient } from "./llm.ts"
import { runAgent } from "./loop.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { loadConfig, applyConfigToEnv } from "./config.ts"
import { parsePlanFlags, planUsage, runPlanFile, benchPlanFile, viewPlanFile } from "./influx/plan-cli.ts"
import type { PlanCliFlags } from "./influx/plan-cli.ts"

interface CliFlags {
  headless: boolean
  yes: boolean
  model?: string
  cwd: string
}

function parseArgs(argv: string[]): { flags: CliFlags; promptArgs: string[] } {
  const flags: CliFlags = { headless: false, yes: false, cwd: process.cwd() }
  const promptArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--headless") flags.headless = true
    else if (arg === "--yes") flags.yes = true
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

function emitEvent(e: LoopEvent): void {
  switch (e.type) {
    case "step":
      process.stdout.write(`\n—— 第 ${e.n} 轮 ——\n`)
      return
    case "text":
      process.stdout.write(e.text)
      return
    case "wave-start":
      process.stdout.write(
        e.parallel
          ? `\n⚡ 波次 ${e.n} 并行执行 ${e.calls.length} 个工具:\n`
          : `\n→ 波次 ${e.n}:\n`,
      )
      for (const c of e.calls) process.stdout.write(`   ${c.tool} ${JSON.stringify(c.args).slice(0, 120)}\n`)
      return
    case "tool-start":
      return // 已在 wave-start 中列出
    case "tool-result":
      process.stdout.write(
        e.error ? `   ✗ ${e.tool} (${e.ms.toFixed(0)}ms): ${e.error.slice(0, 120)}\n` : `   ✓ ${e.tool} (${e.ms.toFixed(0)}ms)\n`,
      )
      return
    case "wave-end":
      return
    case "done":
      process.stdout.write(`\n[完成 total ${e.finish}]\n`)
  }
}

// ---------- 计划子命令(plan run|bench|view / 兼容 run|bench|view) ----------

async function planSubcommand(cmd: "run" | "bench" | "view", file: string, flagArgs: string[]): Promise<void> {
  if (!file) {
    console.error(planUsage)
    process.exit(1)
  }
  const flags = parsePlanFlags(flagArgs)
  try {
    if (cmd === "run") await runPlanFile(file, flags)
    else if (cmd === "bench") await benchPlanFile(file, flags)
    else await viewPlanFile(file, flags)
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

async function dispatchPlan(argv: string[]): Promise<void> {
  const [head, next, ...rest] = argv
  if (head === "plan") {
    if (next === "run" || next === "bench" || next === "view") {
      await planSubcommand(next, rest[0] ?? "", rest.slice(1))
      return
    }
    console.error(planUsage)
    process.exit(1)
  }
  // 兼容 influx 旧命令: run|bench|view <plan.tsx>
  if (head === "run" || head === "bench" || head === "view") {
    await planSubcommand(head, next ?? "", rest)
    return
  }
  console.error(planUsage)
  process.exit(1)
}

// ---------- 对话 agent ----------

async function runAgentOnce(flags: CliFlags, rawPrompt: string): Promise<void> {
  const tools = builtinTools()
  const client = createLLMClient()
  const system = buildSystemPrompt({ cwd: flags.cwd, tools })

  const result = await runAgent({
    history: [],
    userMessage: { role: "user", content: rawPrompt },
    tools,
    system,
    cwd: flags.cwd,
    maxSteps: 30,
    requests: (opts) => client.stream(opts),
    ask: ({ tool, summary }) => {
      if (flags.yes) return Promise.resolve(true)
      // 交互 TTY 下从 stdin 读一行确认; 管道/脚本场景无法交互 → 默认拒绝
      if (process.stdin.isTTY) {
        return new Promise<boolean>((resolve) => {
          process.stdout.write(`\n? 允许 ${tool}(${summary})? [y/N] `)
          process.stdin.setEncoding("utf8")
          process.stdin.resume()
          const onData = (chunk: string) => {
            process.stdin.pause()
            process.stdin.off("data", onData)
            resolve(/^\s*y(es)?\s*$/i.test(chunk.trim()))
          }
          process.stdin.once("data", onData)
        })
      }
      process.stdout.write(`\n? 允许 ${tool}(${summary})? 使用 --yes 放行 [y/N] → 默认拒绝\n`)
      return Promise.resolve(false)
    },
    onEvent: emitEvent,
  })

  if (result.finish === "doom_loop") {
    process.stdout.write("\n[danger] doom-loop 触发, 已中止\n")
    process.exit(1)
  }
  process.stdout.write(`\n[finish=${result.finish} steps=${result.steps}]\n`)
}

async function main(): Promise<void> {
  // 启动即加载用户配置: 填充未设置的环境变量(环境变量优先)
  applyConfigToEnv(loadConfig())
  const argv = process.argv.slice(2)

  // 子命令分发: plan / run / bench / view / mcp
  if (argv[0] === "mcp") {
    await import("./influx/mcp.ts")
    return
  }
  if (argv[0] === "plan" || argv[0] === "run" || argv[0] === "bench" || argv[0] === "view") {
    await dispatchPlan(argv)
    return
  }

  const { flags, promptArgs } = parseArgs(argv)

  // 交互模式(默认): 启动 Ink TUI(启动前检测终端主题, 注入 App)
  if (!flags.headless) {
    const { render } = await import("ink")
    const { default: App } = await import("./ui/app.tsx")
    const { createElement } = await import("react")
    const { detectTerminalTheme } = await import("./ui/theme.ts")
    const theme = await detectTerminalTheme()
    // 全屏 TUI: 进入 alternate screen buffer(OSC 1049), 与调用它的终端会话完全解耦。
    // 运行期间整屏由本 TUI 接管(不污染终端滚动历史); 退出时原样恢复调用方终端 ——
    // 参考 tmux/opencode 的客户端模式: "独立的全屏应用, 而不是终端里的一条流"。
    const isTty = process.stdout.isTTY
    if (isTty) process.stdout.write("\x1b[?1049h")
    let restored = false
    const restore = (): void => {
      if (restored || !isTty) return
      restored = true
      process.stdout.write("\x1b[?1049l\x1b[?25h")
    }
    process.on("exit", restore)
    const instance = render(createElement(App, { cwd: flags.cwd, theme: theme ?? undefined }))
    await instance.waitUntilExit()
    restore()
    return
  }

  const rawPrompt = promptArgs.join(" ") || (process.stdin.isTTY ? "" : await readStdin())
  if (!rawPrompt) {
    console.error("未提供 prompt(可以用管道: echo '...' | minicode --headless)")
    process.exit(1)
  }

  await runAgentOnce(flags, rawPrompt)
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
