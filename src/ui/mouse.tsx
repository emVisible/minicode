// 自研 SGR 鼠标协议(零依赖): 终端原始输入里的 \x1b[<b;r;cM/m 序列 → React 事件。
// ink 不解析鼠标, 我们挂一个独立的 stdin data 监听; 启用时向终端写 ?1000h?1006h,
// 结束写 ?1000l?1006l 还原。点按/滚轮都走同一通道。

import { useEffect } from "react"
import type { stdin as TtyStdin } from "process"

export interface MouseEventData {
  /** 1-based 终端行 */
  row: number
  /** 1-based 终端列 */
  col: number
  /** 0=左键, 1=中键, 2=右键; 64=滚轮上, 65=滚轮下 */
  button: number
  /** 按住时是否带修饰键(shift/alt/ctrl, 编码在 b 的高位) */
  ctrl: boolean
  shift: boolean
  alt: boolean
}

interface ParsedSeq {
  row: number
  col: number
  button: number
  released: boolean
}

function parseSgr(s: string): ParsedSeq | null {
  // \x1b[<b;r;cM (按下) / \x1b[<b;r;cm (释放)
  const m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)
  if (!m) return null
  return { button: Number(m[1]), row: Number(m[2]), col: Number(m[3]), released: m[4] === "m" }
}

/**
 * 启用 SGR 鼠标, 把终端点击/滚轮翻译成事件。
 * 独立于 ink 的 useInput(ink 会忽略未知 CSI 序列)。
 */
export function useMouse(onEvent: (e: MouseEventData) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const stdin = process.stdin
    if (!stdin || typeof stdin.setRawMode !== "function") return
    if (!stdin.isTTY) return

    // 启用 SGR 鼠标报告 + 低干扰(X10 扩展位)
    process.stdout.write("\x1b[?1000h\x1b[?1006h")
    let buf = ""
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8")
      // 逐条消费: 序列以 \x1b[< 开头, 以 M/m 结尾
      let idx: number
      while ((idx = buf.indexOf("\x1b[<")) !== -1) {
        const end = buf.slice(idx).search(/[Mm]/)
        if (end === -1) break
        const seq = buf.slice(idx, idx + end + 1)
        buf = buf.slice(idx + end + 1)
        const parsed = parseSgr(seq)
        if (!parsed || parsed.released) continue
        const raw = parsed.button
        const wheel = raw >= 64 ? (raw >= 65 ? 65 : 64) : raw & 0b11
        onEvent({
          row: parsed.row,
          col: parsed.col,
          button: wheel,
          ctrl: (raw >> 4 & 1) === 1,
          shift: (raw >> 2 & 1) === 1,
          alt: (raw >> 3 & 1) === 1,
        })
      }
    }
    stdin.on("data", onData)
    return () => {
      stdin.removeListener("data", onData)
      process.stdout.write("\x1b[?1000l\x1b[?1006l")
    }
  }, [enabled, onEvent])
}
