// TUI 端到端回归: 真 PTY(python3 驱动)下运行完整 TUI, 断言会话文件(状态真值)
//
// 验证: ① 输入消息 → 假 LLM 流式回答 → 会话文件落盘含 assistant 消息
//       ② Ctrl+C 双击退出(首按提示, 3s 内再按退出, exitCode 0)
//       ③ Esc 不再退出(Esc 后程序仍在运行, 双击 Ctrl+C 才退出)
//       ④ 命令行模式: Tab 切换后输入 echo 直接执行并回显
//
// 环境: MINICODE_HOME 指向临时目录(会话/日志隔离); python3 驱动 PTY

import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

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

// ---------- 假 LLM: 流式回答, 无工具 ----------

function startMock(port: number): Promise<{ close: () => void }> {
  const text = "这是对「你好世界」的回答。任务已经完成, 没有调用任何工具。"
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      let i = 0
      const iv = setInterval(() => {
        i += 2
        if (i <= text.length) {
          try {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i - 2, i) }, index: 0 }] })}\n\n`)
          } catch {}
        } else {
          clearInterval(iv)
          try {
            res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "stop", index: 0 }], usage: {} })}\n\n`)
            res.write("data: [DONE]\n\n")
            res.end()
          } catch {}
        }
      }, 30)
    })
  })
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ close: () => server.close() }))
  })
}

/** 慢速假 LLM: 首字符延迟 delayMs, 用于长回答完成通知(≥8s)场景 */
function startSlowMock(port: number, delayMs: number): Promise<{ close: () => void }> {
  const text = "慢速回答: 完成了。"
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        let i = 0
        const iv = setInterval(() => {
          i += 2
          if (i <= text.length) {
            try {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i - 2, i) }, index: 0 }] })}\n\n`)
            } catch {}
          } else {
            clearInterval(iv)
            try {
              res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "stop", index: 0 }], usage: {} })}\n\n`)
              res.write("data: [DONE]\n\n")
              res.end()
            } catch {}
          }
        }, 30)
      }, delayMs)
    })
  })
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ close: () => server.close() }))
  })
}

// ---------- python3 PTY 驱动 ----------

const PY_DRIVER = `
import os, pty, sys, time, select, fcntl, termios, struct

out_path = sys.argv[1]
warmup = float(sys.argv[2])
post = float(sys.argv[3])
esc_first = len(sys.argv) > 4 and sys.argv[4] == "esc"
tab_first = len(sys.argv) > 4 and sys.argv[4] == "tab"
danger_first = len(sys.argv) > 4 and sys.argv[4] == "danger"
status_probe = len(sys.argv) > 4 and sys.argv[4] == "status"

def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.environ["TUI_CWD"])
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])

set_size(fd, 32, 110)
captured = b""
def pump(duration):
    global captured
    end = time.time() + duration
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk: break
            captured += chunk

try:
    pump(warmup)
    if tab_first:
        # 场景 C: Tab 切命令行模式 → 输入 echo 命令执行 → 回显输出
        os.write(fd, b"\\t")
        pump(0.5)
        os.write(fd, ("echo 命令模式OK").encode("utf-8"))
        pump(0.2)
        os.write(fd, b"\\r")
        pump(post)
    elif danger_first:
        # 场景 D: 危险命令(rm -rf /)不直接执行, 出现确认框; Esc 拒绝后继续运行
        os.write(fd, b"\\t")
        pump(0.5)
        os.write(fd, b"rm -rf / --e2e-noop")
        pump(0.2)
        os.write(fd, b"\\r")
        pump(post)
        os.write(fd, b"\\x1b")
        pump(1.0)
    elif status_probe:
        # 场景 E: 默认状态行可见 → /statusline 关闭 → /status 总览
        os.write(fd, b"/statusline")
        pump(0.2)
        os.write(fd, b"\\r")
        pump(1.2)
        os.write(fd, b"/status")
        pump(0.2)
        os.write(fd, b"\\r")
        pump(1.5)
    else:
        if esc_first:
            # 场景 B: 先按 Esc(应显示"取消"提示而不是退出), 再正常聊天
            os.write(fd, b"\\x1b")
            pump(0.8)
        os.write(fd, ("你好世界").encode("utf-8"))
        pump(0.2)
        os.write(fd, b"\\r")
        pump(post)
    os.write(fd, b"\\x03")
    pump(0.3)
    os.write(fd, b"\\x03")
    pump(2.0)
    try:
        os.close(fd)
    except OSError:
        pass
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
except Exception:
    code = -99

open(out_path, "wb").write(captured)
print("EXIT_CODE=%d" % code)
sys.exit(0)
`

interface Session {
  msgs: Array<{ kind: string; text: string }>
}

function latestSession(home: string): Session {
  const dir = join(home, "sessions")
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  const recs = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Session)
  return recs[0] ?? { msgs: [] }
}

interface RunResult {
  exitCode: number
  out: string
  driverErr: string
}

function runTui({ warmup, post, home, llmUrl, escFirst, tabFirst, dangerFirst, statusFirst }: { warmup: number; post: number; home: string; llmUrl: string; escFirst?: boolean; tabFirst?: boolean; dangerFirst?: boolean; statusFirst?: boolean }): Promise<RunResult> {
  const outPath = join(tmpdir(), `tui-capture-${Date.now()}.txt`)
  const args = ["-c", PY_DRIVER, outPath, String(warmup), String(post)]
  if (escFirst) args.push("esc")
  if (tabFirst) args.push("tab")
  if (dangerFirst) args.push("danger")
  if (statusFirst) args.push("status")
  return new Promise((resolve) => {
    const child = spawn("python3", args, {
      env: {
        ...process.env,
        TUI_CWD: process.cwd(),
        MINICODE_HOME: home,
        LLM_URL: llmUrl,
        LLM_MODEL: "mock",
        MINICODE_EXA_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    const kill = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.on("close", () => {
      clearTimeout(kill)
      let exitCode = -99
      const m = out.match(/EXIT_CODE=(-?\d+)/)
      if (m) exitCode = Number(m[1])
      const cap = readFileSync(outPath, "utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
      rmSync(outPath, { force: true })
      resolve({ exitCode, out: cap, driverErr: err })
    })
  })
}

// ---------- 场景 A: 消息 → 流式回答 → 落盘 → 双击退出 ----------

async function scenarioA(): Promise<void> {
  console.log("\nA: 消息 → 流式回答 → 会话落盘 → Ctrl+C 双击退出")
  const home = mkdtempSync(join(tmpdir(), "tui-home-"))
  const mock = await startMock(9731)
  const r = await runTui({
    warmup: 3.0,
    post: 7.0,
    home,
    llmUrl: "http://127.0.0.1:9731/v1/chat/completions",
  })
  mock.close()

  const sess = latestSession(home)
  const texts = sess.msgs.map((m) => m.text).join("\n")
  check("A1 用户消息入会话", texts.includes("你好世界"), JSON.stringify(sess.msgs.slice(0, 3)))
  check("A2 助手回答入会话", texts.includes("这是对「你好世界」的回答"), texts.slice(0, 200))
  check("A3 回答完成 verdict", sess.msgs.some((m) => m.kind === "verdict"), JSON.stringify(sess.msgs.slice(-3)))
  check("A4 Ctrl+C 双击正常退出", r.exitCode === 0, `exit=${r.exitCode}`)
  rmSync(home, { recursive: true, force: true })
}

// ---------- 场景 B: Esc 不再退出(仅提示) ----------

async function scenarioB(): Promise<void> {
  console.log("\nB: Esc 不退出, 双击 Ctrl+C 才退出")
  const home = mkdtempSync(join(tmpdir(), "tui-home-"))
  const mock = await startMock(9732)
  const r = await runTui({
    warmup: 2.5,
    post: 6.0,
    home,
    llmUrl: "http://127.0.0.1:9732/v1/chat/completions",
    escFirst: true,
  })
  mock.close()
  check("B1 Esc 后未退出(仍完成一次对话)", r.out.includes("这是对「你好世界」的回答"), r.out.slice(0, 200))
  check("B2 Esc 提示取消而非退出", r.out.includes("为了") || r.out.includes("取消"), r.out.slice(0, 300))
  check("B3 最终 Ctrl+C 双击退出", r.exitCode === 0, `exit=${r.exitCode}`)
  rmSync(home, { recursive: true, force: true })
}

// ---------- 场景 C: 命令行模式(Tab) ----------

async function scenarioC(): Promise<void> {
  console.log("\nC: Tab 切命令行 → echo 直接执行")
  const home = mkdtempSync(join(tmpdir(), "tui-home-"))
  const r = await runTui({
    warmup: 2.5,
    post: 4.0,
    home,
    llmUrl: "http://127.0.0.1:9733/v1/chat/completions",
    tabFirst: true,
  })
  const out = r.out
  check("C1 Tab 提示命令行模式", out.includes("命令行模式"), out.slice(0, 200))
  check("C2 命令回显并在输出中", out.includes("echo 命令模式OK") && out.includes("命令模式OK"), JSON.stringify(out.split("\n").filter((l) => l.includes("模式OK"))))
  check("C3 双击 Ctrl+C 退出", r.exitCode === 0, `exit=${r.exitCode}`)
  rmSync(home, { recursive: true, force: true })
}

// ---------- 场景 D: 危险命令确认闸门 ----------

async function scenarioD(): Promise<void> {
  console.log("\nD: 危险命令(rm -rf /)先弹确认框, Esc 拒绝后不执行")
  const home = mkdtempSync(join(tmpdir(), "tui-home-"))
  const r = await runTui({
    warmup: 2.5,
    post: 3.5,
    home,
    llmUrl: "http://127.0.0.1:9734/v1/chat/completions",
    dangerFirst: true,
  })
  const out = r.out
  check("D1 危险命令不直接执行(出现确认框)", out.includes("危险命令") && out.includes("rm -rf / --e2e-noop"), JSON.stringify(out.split("\n").filter((l) => l.includes("危险"))))
  check("D2 Esc 拒绝后提示已取消", out.includes("已取消"), out.slice(-400))
  check("D3 拒绝后程序可用, 双击 Ctrl+C 退出", r.exitCode === 0, `exit=${r.exitCode}`)
  rmSync(home, { recursive: true, force: true })
}

// ---------- 场景 E: v0.7 状态行 / /statusline / /status ----------

async function scenarioE(): Promise<void> {
  console.log("\nE: 状态行默认开 → /statusline 关闭 → /status 总览")
  const home = mkdtempSync(join(tmpdir(), "tui-home-"))
  const mock = await startMock(9735)
  const r = await runTui({
    warmup: 3.0,
    post: 5.0,
    home,
    llmUrl: "http://127.0.0.1:9735/v1/chat/completions",
    statusFirst: true,
  })
  mock.close()
  const out = r.out
  check("E1 默认底部状态行可见(model + 会话 tokens)", out.includes("mock") && out.includes("↑0 ↓0"), JSON.stringify(out.split("\n").filter((l) => l.includes("↑0 ↓0")).slice(-2)))
  check("E2 /statusline 切换有确认提示", out.includes("状态行已关闭"), out.slice(-500))
  check("E3 /status 总览含上下文占用与开关状态", out.includes("会话总览") && out.includes("上下文占用") && out.includes("状态行: 关"), out.slice(-700))
  check("E4 双击 Ctrl+C 退出", r.exitCode === 0, `exit=${r.exitCode}`)
  rmSync(home, { recursive: true, force: true })
}

// ---------- 场景 F: 长回答(≥8s)完成通知(BEL) ----------

async function scenarioF(): Promise<void> {
  console.log("\nF: 慢速回答 → 完成时终端通知(BEL)")
  const home = mkdtempSync(join(tmpdir(), "tui-home-"))
  const mock = await startSlowMock(9736, 9_000)
  const r = await runTui({
    warmup: 2.5,
    post: 12.0,
    home,
    llmUrl: "http://127.0.0.1:9736/v1/chat/completions",
  })
  mock.close()
  check("F1 慢速回答完成(BEL 通知序列已发射)", r.out.includes("\u0007"), `BEL present: ${r.out.includes("\u0007")} · 尾部: ${r.out.slice(-120)}`)
  check("F2 回答文本落入会话", r.out.includes("慢速回答"), r.out.slice(0, 200))
  check("F3 双击 Ctrl+C 退出", r.exitCode === 0, `exit=${r.exitCode}`)
  rmSync(home, { recursive: true, force: true })
}

async function main(): Promise<void> {
  console.log("TUI e2e (PTY)")
  await scenarioA()
  await scenarioB()
  await scenarioC()
  await scenarioD()
  await scenarioE()
  await scenarioF()
  console.log(`\nTUI e2e: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()