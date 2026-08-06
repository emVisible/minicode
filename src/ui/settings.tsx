// 设置面板 —— 无边框分区, 焦点字段强调色高亮, Tab/↑↓ 切换, Enter 保存, Esc 取消

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import { Input } from "./input.tsx"
import type { MinicodeConfig } from "../config.ts"
import type { ThemeTokens } from "./theme.ts"

const FIELDS: Array<{ key: keyof MinicodeConfig; label: string; placeholder: string; secret?: boolean }> = [
  { key: "llmUrl", label: "LLM URL", placeholder: "https://api.openai.com/v1" },
  { key: "llmApiKey", label: "API Key", placeholder: "sk-...", secret: true },
  { key: "llmModel", label: "Model", placeholder: "gpt-4o-mini" },
]

export function SettingsPanel(props: {
  draft: MinicodeConfig
  field: number
  t: ThemeTokens
  onChange: (key: keyof MinicodeConfig, value: string) => void
}): ReactNode {
  const { draft, field, t, onChange } = props

  const displayValue = (f: (typeof FIELDS)[number]): string => {
    const v = draft[f.key] ?? ""
    if (!v) return ""
    if (f.secret && v.length > 8) return `••••••••${v.slice(-4)}`
    return v
  }

  return (
    <Box marginTop={1} flexDirection="column" width="100%">
      <Text color={t.accent} bold>
        ⚙ 设置
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {FIELDS.map((f, i) => {
          const active = i === field
          return (
            <Box key={f.key} flexDirection="row">
              <Box width={10}>
                <Text color={active ? t.accent : t.inkDim} bold={active}>
                  {active ? "▸ " : "  "}
                  {f.label}
                </Text>
              </Box>
              {active ? (
                <Input
                  value={draft[f.key] ?? ""}
                  focus
                  t={t}
                  placeholder={f.placeholder}
                  onChange={(v) => onChange(f.key, v)}
                />
              ) : (
                <Text color={t.ink}>{displayValue(f) || <Text color={t.inkFaint}>(未设置)</Text>}</Text>
              )}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={t.inkFaint}>Tab/↑↓ 切换 · 输入编辑 · Enter 保存并生效 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
