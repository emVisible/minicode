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

/** 消息块在宽度 width 下的估算行数(含头部行)。 */
export function estimateMsgHeight(m: ChatMsg, width: number): number {
  switch (m.kind) {
    case "user":
      // 头部"你 + 时间"一行 + 正文(纯文本, 按 markdown 近似即可)
      return 1 + estimateMarkdownHeight(m.text, width)
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
 * start/end 为块索引, startPad 为顶部对齐补齐行数(让被切到的块顶端对齐视口顶),
 * visibleH 为切片总行数(调用方用剩余高度做底部填充, 保证贴底布局)。
 */
export function computeWindow(
  heights: number[],
  viewportH: number,
  offset: number,
): { start: number; startPad: number; end: number; visibleH: number } {
  const off = clampOffset(offset, viewportH, heights)
  let start = 0
  let acc = 0
  while (start < heights.length && acc + heights[start]! <= off) {
    acc += heights[start]!
    start++
  }
  const startPad = off - acc
  let end = start
  let visibleH = 0
  while (end < heights.length && visibleH + heights[end]! <= viewportH - startPad) {
    visibleH += heights[end]!
    end++
  }
  return { start, startPad, end, visibleH }
}
