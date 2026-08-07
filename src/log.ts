// 日志体系 —— 面向后续优化的完整日志 + 报错机制
//
// 设计:
//   - 分级: debug < info < warn < error, MINICODE_LOG_LEVEL 控制(默认 info)
//   - 落盘: ~/.minicode/logs/minicode-YYYYMMDD.log(按天分文件), 单文件超 2MB 轮转 .old
//   - 结构化: [ISO时间] [级别] [作用域] 消息  {json 可选}
//   - 崩溃兜底: uncaughtException / unhandledRejection 写入 error 级并保留堆栈
//   - /log 命令: 把最近日志尾部回显到对话流(logTail)
// 全程同步写(appendFileSync), TUI 渲染不被打断; 写失败静默(不影响主流程)。

import { appendFileSync, readFileSync, renameSync, statSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function resolveLevel(): LogLevel {
  const v = (process.env.MINICODE_LOG_LEVEL ?? "info").toLowerCase()
  if (v === "debug" || v === "warn" || v === "error") return v
  return "info"
}

const MAX_FILE_BYTES = 2 * 1024 * 1024

function logDir(): string {
  return join(homedir(), ".minicode", "logs")
}

function todayFile(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, "0")
  return join(logDir(), `minicode-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`)
}

/** 当前生效的日志文件路径(供 UI 展示) */
export function logPath(): string {
  return todayFile()
}

/** 单行写入(含轮转) */
function writeLine(line: string): void {
  try {
    const file = todayFile()
    mkdirSync(logDir(), { recursive: true })
    // 轮转: 超限 → 旧文件改名为 .old
    try {
      if (statSync(file).size > MAX_FILE_BYTES) {
        renameSync(file, file + ".old")
      }
    } catch {
      // 文件不存在 → 首次写入, 无需轮转
    }
    appendFileSync(file, line + "\n", "utf8")
  } catch {
    // 日志失败不能影响主流程
  }
}

let currentLevel: LogLevel = resolveLevel()

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

function emit(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const ts = new Date().toISOString()
  const json = data === undefined ? "" : ` ${JSON.stringify(data)}`
  writeLine(`${ts} [${level}] [${scope}] ${msg}${json}`)
}

export const log = {
  debug(scope: string, msg: string, data?: unknown): void {
    emit("debug", scope, msg, data)
  },
  info(scope: string, msg: string, data?: unknown): void {
    emit("info", scope, msg, data)
  },
  warn(scope: string, msg: string, data?: unknown): void {
    emit("warn", scope, msg, data)
  },
  error(scope: string, msg: string, data?: unknown): void {
    emit("error", scope, msg, data)
  },
}

/** 读取最近 n 行日志(供 /log 命令回显) */
export function logTail(n = 40): string[] {
  try {
    const file = todayFile()
    const raw = readFileSync(file, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim())
    return lines.slice(-n)
  } catch {
    return ["(暂无日志记录)"]
  }
}

/** 崩溃兜底: 未捕获异常/拒绝都进日志(带堆栈), 控制台保留原有输出 */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    log.error("process", "uncaughtException", { message: err.message, stack: err.stack })
  })
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : undefined
    log.error("process", "unhandledRejection", { message: msg, stack })
  })
}

/** 记录进程生命周期事件(启动参数/退出码) */
export function logSessionStart(argv: string[], cwd: string): void {
  log.info("session", "start", { argv, cwd, pid: process.pid, node: process.version })
}

export function logSessionEnd(exitCode: number): void {
  log.info("session", "end", { exitCode, pid: process.pid })
}
