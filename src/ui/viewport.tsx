// 终端视口滚动 —— 把全屏终端当网页来滚动(对齐 opencode 的滚动交互)。
// 关键约束: ink 不裁剪溢出内容, 只能"只渲染视口内窗口"(虚拟化切片),
// 而不是依赖外层裁剪。高度估算基于 CJK 感知的 displayWidth 换行计数。
//
// 语义:
//   - lockBottom = 贴底模式: 内容增长时自动滚到底部(对话天然钉底)
//   - 用户手动 ↑ 上滚 → 解锁; 回到底部 → 重新上锁(网页感)
//   - 视口底部之外的内容交给调用方渲染(输入框等系统层固定不滚动)

import { useEffect, useState } from "react"
import type { ChatMsg } from "../types.ts"
import { displayWidth } from "./markdown.tsx"

// ---------- 终端尺寸(resize 感知) ----------

export interface TermStream {
  columns?: number
  rows?: number
  on(ev: "resize", cb: () => void): unknown
  off(ev: "resize", cb: () => void): unknown
}

export function useTerminalSize(stdout: TermStream): { cols: number; rows: number } {
  const [size, setSize] = useState({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
  useEffect(() => {
    const onResize = (): void => setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on("resize", onResize)
    return () => {
      stdout.off("resize", onResize)
    }
  }, [stdout])
  return size
}

// ---------- 高度估算 ----------

/**
 * Markdown 文本在宽度 w 下的渲染行数估算:
 * 代码块/表格/空行逐行计; 普通行按 displayWidth 换行计。≈ 渲染器实际行数。
 */
export function estimateMarkdownHeight(text: string, w: number): number {
  if (!text) return 0
  let h = 0
  let inCode = false
  for (const line of text.split("\n")) {
    const t = line.trimStart()
    if (t.startsWith("```")) {
      inCode = !inCode
      h += 1
      continue
    }
    if (inCode) {
      h += 1
      continue
    }
    if (!line.trim()) {
      h += 1
      continue
    }
    if (t.startsWith("|") && t.endsWith("|")) {
      h += 1
      continue
    }
    const plain = line.replace(/[#*_>`~[\]()]/g, "")
    h += Math.max(1, Math.ceil(displayWidth(plain) / Math.max(1, w)))
  }
  return h
}

/**
 * 聊天气泡宽度(与 MsgBlock 渲染、高度估算共用同一语义):
 * 单行文本按内容宽度收窄(不超过 maxW, 气泡内嵌左右 padding); 多行文本回落全宽。
 */
export function bubbleWidth(text: string, maxW: number): number {
  if (text.includes("\n")) return maxW
  return Math.min(maxW, Math.max(displayWidth(text) + 2, 6))
}

/** 消息块在宽度 width 下的估算行数(含头部行)。 */
export function estimateMsgHeight(m: ChatMsg, width: number): number {
  switch (m.kind) {
    case "user":
      // 头部"你 + 时间"一行 + 右对齐气泡(按气泡内宽 wrap 计数)
      return 1 + estimateMarkdownHeight(m.text, Math.max(1, bubbleWidth(m.text, width) - 2))
    case "assistant":
      // 边框/内边距吃掉 2 列(与 MsgBlock 的 width - 2 一致)
      return 1 + estimateMarkdownHeight(m.text, Math.max(1, width - 2))
    case "verdict":
    case "danger":
    case "info":
      return 1 + (m.detail ?? []).reduce((a, d) => a + estimateMarkdownHeight(d, width), 0)
  }
}

/** 估算总高度。 */
export function totalHeight(heights: number[]): number {
  let t = 0
  for (const h of heights) t += h
  return t
}

/** 把 offset 收敛到 [0, max(0, total - viewport)]。 */
export function clampOffset(offset: number, viewportH: number, heights: number[]): number {
  const max = Math.max(0, totalHeight(heights) - viewportH)
  return Math.min(Math.max(0, offset), max)
}

/**
 * 虚拟窗口切片: 给定各块高度与视口高度, 返回应该渲染的切片范围。
 *
 * 语义:
 *   - start: 覆盖视口顶边 off 的块(视口顶边落在块中部时, 该块也不跳过)
 *   - startPad: 该块顶部已滚出视口的行数(文本裁剪掉, 显示真实内容而非空白占位)
 *   - end: 开区间, 所有与 [off, off+viewportH) 相交的块都包含(含视口底部被切到的块)
 *   - endClip: 末块在视口下方溢出的行数(调用方据此做底部文本裁剪)
 *   - visibleH: 裁剪后实际渲染的行数
 * 关键语义(修复"消息消失/无法回滚"根因): 视口顶/底都会"落在块内部",
 * 任何偏移下视口里都有真实可读的文本, 而不是空白占位或整块跳过。
 */
export function computeWindow(
  heights: number[],
  viewportH: number,
  offset: number,
): { start: number; startPad: number; end: number; visibleH: number; endClip: number } {
  const off = clampOffset(offset, viewportH, heights)
  if (heights.length === 0) return { start: 0, startPad: 0, end: 0, visibleH: 0, endClip: 0 }
  // cum[i] = 第 i 块顶边的文档行号(即前 i 块高度和)
  const cum: number[] = [0]
  for (let i = 0; i < heights.length; i++) cum.push(cum[cum.length - 1]! + heights[i]!)
  // start: 覆盖 off 的那块(块顶边 <= off < 块底边)
  let start = 0
  while (start < heights.length - 1 && cum[start + 1]! <= off) start++
  const startPad = Math.min(off - cum[start]!, heights[start]! - 1)
  // 窗口下边: 覆盖 bottom 的那块(再 +1 出开区间 end);
  // 内容比视口矮时 bottom 超出文档尾 → end 封顶到 len
  const bottom = off + viewportH
  let endBlock = start
  while (endBlock < heights.length - 1 && cum[endBlock + 1]! < bottom) endBlock++
  const end = endBlock + 1
  const endClip = Math.max(0, cum[end]! - bottom)
  const visibleH = Math.max(0, (cum[end]! - cum[start]!) - startPad - endClip)
  return { start, startPad, end, visibleH, endClip }
}

/**
 * 按行裁剪文本: 去掉前 skipRows 行(近似), 返回裁剪后的文本。
 * 用于被视口切到的块 —— 显示真实内容而不是空置区。
 * 行数统计与 estimateMarkdownHeight 同一口径(代码块/表格/空行/换行)。
 */
export function clipTextRows(text: string, skipRows: number, width: number): string {
  if (skipRows <= 0) return text
  const lines = text.split("\n")
  let hidden = 0
  let from = 0
  for (; from < lines.length; from++) {
    const h = lineHeightOf(lines[from]!, width)
    if (hidden + h > skipRows) break
    hidden += h
  }
  if (from >= lines.length) return ""
  // 露头行: 可见的是它的底部 (skipRows - hidden) 行 → 按比例截该行
  const h = lineHeightOf(lines[from]!, width)
  const visibleRows = h - (skipRows - hidden)
  let line = lines[from]!
  if (visibleRows < h) {
    const frac = Math.max(0.15, visibleRows / h)
    line = line.slice(Math.max(0, Math.floor(line.length * (1 - frac))))
  }
  const rest = lines.slice(from + 1).join("\n")
  return (hidden > 0 || line !== lines[from]! ? "…\n" : "") + line + (rest ? "\n" + rest : "")
}

/** 单行文本在宽度 width 下的近似行数(与 estimateMarkdownHeight 同一口径)。 */
function lineHeightOf(line: string, width: number): number {
  const t = line.trimStart()
  if (t.startsWith("```")) return 1
  if (!line.trim() || (t.startsWith("|") && t.endsWith("|"))) return 1
  const plain = line.replace(/[#*_>`~[\]()]/g, "")
  return Math.max(1, Math.ceil(displayWidth(plain) / Math.max(1, width)))
}

/**
 * 保留文本顶部 keepRows 行, 裁掉底部(视口尾部被切到的块用):
 * 与 clipTextRows 相对 —— clipTextRows 裁顶部(视口头部被切的块)。
 */
export function clipTextRowsKeep(text: string, keepRows: number, width: number): string {
  if (keepRows <= 0) return ""
  const lines = text.split("\n")
  let kept = 0
  let to = lines.length
  for (let i = 0; i < lines.length; i++) {
    const h = lineHeightOf(lines[i]!, width)
    if (kept + h > keepRows) {
      to = i
      break
    }
    kept += h
  }
  const rest = lines.slice(0, to).join("\n")
  return rest + (to < lines.length ? "\n…" : "")
}
