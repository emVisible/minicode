// 状态行 —— v0.7 轻量页脚: 一行显示 model · 会话 tokens · 今日 tokens · 会话时长。
// 设计(axiom): 默认开但极简, 只给"正在用什么/烧了多少/这轮多久"三个信号; /statusline 可关。

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { ThemeTokens } from "./theme.ts"
import { fmtTokens, sessionUsage, usageSummary } from "../usage.ts"

export function formatDuration(ms: number): string {
  const sec = Math.max(0, ms)
  const m = Math.floor(sec / 60000)
  const s = Math.floor((sec % 60000) / 1000)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${m}:${p(s)}`
}

export function StatusLine(props: { t: ThemeTokens; model: string; sessionId: string; sinceMs: number; width?: number }): ReactNode {
  const { t, model, sessionId, sinceMs, width } = props
  const s = sessionUsage(sessionId)
  const { today } = usageSummary()
  const parts = [
    model,
    s ? `↑${fmtTokens(s.inputTokens)} ↓${fmtTokens(s.outputTokens)}` : "↑0 ↓0",
    `今日 ${fmtTokens(today.inputTokens + today.outputTokens)}`,
    formatDuration(Date.now() - sinceMs),
  ]
  // 单行封顶(截断, 不换行): 状态行绝不允许让整帧高度 +1
  const text = [...parts.join(" · ")].slice(0, Math.max(1, (width ?? 80) - 2)).join("")
  return (
    <Box flexDirection="row" width="100%">
      <Text color={t.inkFaint} dimColor>
        {text}
      </Text>
    </Box>
  )
}