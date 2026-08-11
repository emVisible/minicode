// 命令面板 —— 独立的"提示"视图(主动拉取, 不主动推送)
// 打开: Ctrl+P 或给 "/" 输入开头; 打字过滤; ↑↓ 选择; Enter 执行; Esc 关闭
// 两个阶段: "commands"(命令表) / "sessions"(历史会话, 从"会话记录"进入)
// 设计: 全界面唯一的提示区 —— 常规界面上不再推任何操作提示。

import React from "react"
import type { ReactNode } from "react"
import { Box, Text, useStdout } from "ink"
import type { ThemeTokens } from "./theme.ts"
import { PALETTE_MAX_ROWS } from "../commands.ts"
import { displayWidth } from "./markdown.tsx"

/** 按显示宽截断(超宽加省略号), 保证列表行恒为单行 → 面板行数可控不溢出 */
function truncateW(s: string, max: number): string {
  if (max <= 0) return ""
  let w = 0
  let out = ""
  for (const ch of s) {
    const cw = ch === "\n" ? 1 : displayWidth(ch)
    if (w + cw > max) return out.length > 0 ? out + "…" : "…"
    out += ch
    w += cw
  }
  return out
}

export interface PaletteRow {
  group: string
  cmd: string
  desc: string
  shortcut?: string
}

export interface SessionRow {
  id: string
  label: string
  meta: string
}

type HandledRow = PaletteRow | SessionRow

export function PalettePanel({
  t,
  phase,
  mode,
  query,
  sel,
  rows,
  sessions,
  archivedScope,
}: {
  t: ThemeTokens
  phase: "commands" | "sessions"
  mode: "browse" | "rename"
  query: string
  sel: number
  rows: PaletteRow[]
  sessions: SessionRow[]
  archivedScope?: boolean
}): ReactNode {
  const renaming = phase === "sessions" && mode === "rename"
  // 列表窗口: 高亮行始终可见(↑↓ 长列表不再"出界"), 屏外项不渲染
  const src: Array<HandledRow> = phase === "commands" ? rows : sessions
  const total = src.length
  const { stdout } = useStdout()
  const cols = stdout.columns ?? 80
  const first = Math.max(0, Math.min(sel - PALETTE_MAX_ROWS + 1, Math.max(0, total - PALETTE_MAX_ROWS)))
  const visible = src.slice(first, first + PALETTE_MAX_ROWS)
  const labelBudget = Math.max(8, cols - 30)
  return (
    <Box flexDirection="column" width="100%" marginTop={1} borderStyle="single" borderColor={t.accentDim} paddingX={1} paddingY={1}>
      <Box flexDirection="row">
        <Text color={t.accent} bold>
          ⌘ {renaming ? "重命名" : phase === "sessions" ? (archivedScope ? "已归档会话" : "会话") : "命令"}
        </Text>
        <Text color={t.inkDim}>　{renaming ? "输入新名字 · Enter 保存 · Esc 取消" : phase === "sessions" ? (archivedScope ? `已归档 (${total}) — Enter 恢复 · a 取消归档` : `历史会话 (${total}) — Enter 恢复 · d 删 · r 改名 · a 归档`) : `命令 (${total}) — 过滤 · Enter 执行 · Esc 关闭`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={t.ink} wrap="wrap">
          <Text color={t.accent} bold>
            {"> "}
          </Text>
          {query || "输入过滤…"}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {phase === "commands" ? (
          rows.length === 0 ? (
            <Text color={t.inkFaint}>没有匹配的命令 · 回车退回输入继续编辑(首字符 / 将原样发送)</Text>
          ) : (
                        visible.map((r, i) => {
              const row = r as PaletteRow
              const idx = first + i
              const focused = idx === sel
              return (
                <Box key={`${row.group}${row.cmd}${i}`} flexDirection="row">
                  <Box width={2}>
                    <Text color={focused ? t.accent : t.inkFaint} bold={focused}>
                      {focused ? "▸ " : "  "}
                    </Text>
                  </Box>
                  <Box width={11}>
                    <Text color={focused ? t.accent : t.inkDim} bold={focused}>
                      {truncateW(row.cmd, 11)}
                    </Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={focused ? t.ink : t.inkFaint}>{truncateW(row.desc, labelBudget)}</Text>
                  </Box>
                  {row.shortcut && (
                    <Box>
                      <Text color={t.inkFaint}>{row.shortcut}</Text>
                    </Box>
                  )}
                </Box>
              )
            })
          )
        ) : sessions.length === 0 ? (
          <Text color={t.inkFaint}>{archivedScope ? "还没有已归档的会话(/sessions 列表可 a 归档)" : "还没有保存的会话"}</Text>
        ) : (
          visible.map((s, i) => {
            const row = s as SessionRow
            const idx = first + i
            const focused = idx === sel
            const isNew = row.id === "__new__"
            return (
              <Box key={row.id} flexDirection="row">
                <Box width={2}>
                  <Text color={focused ? t.accent : t.inkFaint} bold={focused}>
                    {focused ? "▸ " : "  "}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={isNew ? t.accent : focused ? t.accent : t.ink} bold={isNew}>
                    {truncateW(row.label, labelBudget)}
                  </Text>
                </Box>
                {row.meta && (
                  <Box>
                    <Text color={t.inkFaint}>{truncateW(row.meta, 26)}</Text>
                  </Box>
                )}
              </Box>
            )
          })
        )}
        {total > PALETTE_MAX_ROWS && (
          <Text color={t.inkFaint}>… {total - PALETTE_MAX_ROWS} 项未显示 · ↑↓ 滚动 · PgUp/PgDn/Home/End 快跳</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={t.inkFaint} dimColor>
          输入过滤 · ↑↓ 选择 · Enter 执行 · Esc 关闭 — 所有命令都能从这里找到
        </Text>
      </Box>
    </Box>
  )
}