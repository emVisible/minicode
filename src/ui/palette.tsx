// 命令面板 —— 独立的"提示"视图(主动拉取, 不主动推送)
// 打开: Ctrl+P 或给 "/" 输入开头; 打字过滤; ↑↓ 选择; Enter 执行; Esc 关闭
// 两个阶段: "commands"(命令表) / "sessions"(历史会话, 从"会话记录"进入)
// 设计: 全界面唯一的提示区 —— 常规界面上不再推任何操作提示。

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { ThemeTokens } from "./theme.ts"
import { PALETTE_MAX_ROWS } from "../commands.ts"

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

export function PalettePanel({
  t,
  phase,
  mode,
  query,
  sel,
  rows,
  sessions,
}: {
  t: ThemeTokens
  phase: "commands" | "sessions"
  mode: "browse" | "rename"
  query: string
  sel: number
  rows: PaletteRow[]
  sessions: SessionRow[]
}): ReactNode {
  const renaming = phase === "sessions" && mode === "rename"
  return (
    <Box flexDirection="column" width="100%" marginTop={1} borderStyle="single" borderColor={t.accentDim} paddingX={1} paddingY={1}>
      <Box flexDirection="row">
        <Text color={t.accent} bold>
          ⌘ {renaming ? "重命名" : phase === "sessions" ? "会话" : "命令"}
        </Text>
        <Text color={t.inkDim}>　{renaming ? "输入新名字 · Enter 保存 · Esc 取消" : phase === "sessions" ? `历史会话 (${sessions.length}) — Enter 恢复 · d 删 · r 改名` : `命令 (${rows.length}) — 过滤 · Enter 执行 · Esc 关闭`}</Text>
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
            rows.slice(0, PALETTE_MAX_ROWS).map((r, i) => (
              <Box key={`${r.group}${r.cmd}${i}`} flexDirection="row">
                <Box width={2}>
                  <Text color={i === sel ? t.accent : t.inkFaint} bold={i === sel}>
                    {i === sel ? "▸ " : "  "}
                  </Text>
                </Box>
                <Box width={11}>
                  <Text color={i === sel ? t.accent : t.inkDim} bold={i === sel} wrap="wrap">
                    {r.cmd}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={i === sel ? t.ink : t.inkFaint} wrap="wrap">
                    {r.desc}
                  </Text>
                </Box>
                {r.shortcut && (
                  <Box>
                    <Text color={t.inkFaint}>{r.shortcut}</Text>
                  </Box>
                )}
              </Box>
            ))
          )
        ) : sessions.length === 0 ? (
          <Text color={t.inkFaint}>还没有保存的会话</Text>
        ) : (
          sessions.slice(0, PALETTE_MAX_ROWS).map((s, i) => (
            <Box key={s.id} flexDirection="row">
              <Box width={2}>
                <Text color={i === sel ? t.accent : t.inkFaint} bold={i === sel}>
                  {i === sel ? "▸ " : "  "}
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={i === sel ? t.accent : t.ink} wrap="wrap">
                  {s.label}
                </Text>
              </Box>
              <Box>
                <Text color={t.inkFaint}>{s.meta}</Text>
              </Box>
            </Box>
          ))
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