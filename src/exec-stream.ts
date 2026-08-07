// 流式命令执行器: spawn 逐 chunk 推送(onChunk), 取代一次性 exec。
// 长命令(build/test/git)在运行中就把 stdout/stderr 实时推给 UI —— 消灭"执行中零信息"。

import { spawn } from "node:child_process"

export interface RunCommandOpts {
  cmd: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 每个 stdout/stderr 数据块的实时回调(按行合并, 保持可读) */
  onChunk?: (text: string) => void
  /** 输出上限(字节); 超过后丢弃继续接收但不再回传, 防止无限增长 */
  maxOutput?: number
}

export interface RunCommandResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

/** 流式执行 shell 命令, 返回完整输出(与 exec 同语义) + 实时 chunk 回调 */
export function runCommandStreaming(opts: RunCommandOpts): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const { cmd, cwd, timeoutMs = 30000, signal, onChunk, maxOutput = 10 * 1024 * 1024 } = opts
    let stdout = ""
    let stderr = ""
    let timedOut = false

    const push = (buf: string, isErr: boolean): void => {
      if (isErr) {
        if (stderr.length < maxOutput) {
          stderr += buf
          onChunk?.(buf)
        }
      } else {
        if (stdout.length < maxOutput) {
          stdout += buf
          onChunk?.(buf)
        }
      }
    }

    const child = spawn(cmd, { shell: true, cwd, env: process.env })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    const abort = (): void => {
      child.kill("SIGTERM")
    }
    signal?.addEventListener("abort", abort, { once: true })

    child.stdout?.on("data", (d: Buffer) => push(d.toString(), false))
    child.stderr?.on("data", (d: Buffer) => push(d.toString(), true))

    child.on("error", (e) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve({ stdout, stderr, code, timedOut })
    })
  })
}

/** 流式执行的统一错误文本(与 exec 报错风格一致, 带 exit code 与 stderr) */
export function runCommandError(r: RunCommandResult, cmd: string): Error {
  if (r.timedOut) return new Error(`命令超时: ${cmd.slice(0, 80)}`)
  const detail = r.stderr.trim() || r.stdout.trim().slice(0, 300) || "(无输出)"
  return new Error(`命令失败(exit ${r.code ?? "?"}): ${detail.slice(0, 800)}`)
}
