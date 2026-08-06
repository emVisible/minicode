// 设置面板 —— 简约卡片式: 标签 + 输入行, Tab/↑↓ 切换, Enter 保存, Esc 取消
// 由 App 通过 Ctrl+o 或 /config 呼出

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import TextInput from "ink-text-input"
import type { MinicodeConfig } from "../config.ts"

const FIELDS: Array<{ key: keyof MinicodeConfig; label: string; placeholder: string; secret?: boolean }> = [
  { key: "llmUrl", label: "LLM URL", placeholder: "https://api.openai.com/v1" },
  { key: "llmApiKey", label: "API Key", placeholder: "sk-...", secret: true },
  { key: "llmModel", label: "Model", placeholder: "gpt-4o-mini" },
]

export function SettingsPanel(props: {
  draft: MinicodeConfig
  field: number
  onChange: (key: keyof MinicodeConfig, value: string) => void
}): ReactNode {
  const { draft, field, onChange } = props

  const displayValue = (f: (typeof FIELDS)[number]): string => {
    const v = draft[f.key] ?? ""
    if (!v) return ""
    if (f.secret && v.length > 8) return `••••••••${v.slice(-4)}`
    return v
  }

  return (
    <Box marginTop={1} flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1} width="100%">
        <Text color="cyan" bold>
          ⚙ 设置
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {FIELDS.map((f, i) => {
            const active = i === field
            return (
              <Box key={f.key} flexDirection="row">
                <Box width={10}>
                  <Text color={active ? "cyan" : "gray"}>
                    {active ? "▸ " : "  "}
                    {f.label}
                  </Text>
                </Box>
                {active ? (
                  <TextInput
                    value={draft[f.key] ?? ""}
                    focus
                    placeholder={f.placeholder}
                    onChange={(v) => onChange(f.key, v)}
                  />
                ) : (
                  <Text color="white">{displayValue(f) || <Text color="gray">(未设置)</Text>}</Text>
                )}
              </Box>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text color="gray">Tab/↑↓ 切换 · 输入编辑 · Enter 保存并生效 · Esc 取消</Text>
        </Box>
      </Box>
    </Box>
  )
}
