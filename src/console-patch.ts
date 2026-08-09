// console 输出重定向 —— 对齐 opencode: TUI 运行期间杂散 console.* 不再污染界面
//
// ink 直接写 process.stdout 渲染, 任何依赖/子进程回调里的 console.log 都会
// 打穿 alternate screen 造成乱屏。TUI 启动前安装本补丁, 把所有 console.*
// 转发到 ~/.minicode/logs/console-{pid}.log(带时间戳); 退出/还原时恢复原函数。
// 还原后(headless / 启动早期)console 行为与原生一致。

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const ORIGINALS = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
  trace: console.trace,
} as const

let outputFile: string | null = null

/** 当前重定向目标文件(未安装时为 null) */
export function consoleOutputPath(): string | null {
  return outputFile
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) return arg.stack ?? arg.message
  try {
    const s = JSON.stringify(arg)
    return s === undefined ? String(arg) : s
  } catch {
    return String(arg)
  }
}

function writeLine(level: string, args: unknown[]): void {
  if (!outputFile) return
  const ts = new Date().toISOString()
  const line = `${ts} [${level}] ${args.map(formatArg).join(" ")}`
  try {
    appendFileSync(outputFile!, line + "\n", "utf8")
  } catch {
    // 重定向失败也不能影响主流程
  }
}

/** 安装重定向: 替换 console.* 为写文件版本, 返回还原函数 */
export function patchConsoleToFile(): () => void {
  if (outputFile) return restoreConsole
  const dir = join(homedir(), ".minicode", "logs")
  try {
    mkdirSync(dir, { recursive: true })
    outputFile = join(dir, `console-${process.pid}.log`)
  } catch {
    return () => {}
  }
  console.log = (...args) => writeLine("log", args)
  console.info = (...args) => writeLine("info", args)
  console.warn = (...args) => writeLine("warn", args)
  console.error = (...args) => writeLine("error", args)
  console.debug = (...args) => writeLine("debug", args)
  console.trace = (...args) => writeLine("trace", args)
  writeLine("info", ["[console-patch] 已安装, 杂散 console.* 写入此文件"])
  return restoreConsole
}

function restoreConsole(): void {
  if (!outputFile) return
  writeLine("info", ["[console-patch] 还原 console.* 到原生"])
  console.log = ORIGINALS.log
  console.info = ORIGINALS.info
  console.warn = ORIGINALS.warn
  console.error = ORIGINALS.error
  console.debug = ORIGINALS.debug
  console.trace = ORIGINALS.trace
  outputFile = null
}
