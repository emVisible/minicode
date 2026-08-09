// 启动欢迎卡片 —— 极简 wordmark + 命令网格(Apple 式: 无边框, 排印表达层级)
// 只渲染一次(首个会话消息前), 随对话滚动到上方

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { ThemeTokens } from "./theme.ts"

export function WelcomeCard(props: { cwd: string; model: string; t: ThemeTokens }): ReactNode {
  const { cwd, model, t } = props
  const rows: Array<[string, string]> = [
    ["Tab", "切换 对话模式 ↔ 命令行(shell)"],
    ["Ctrl+o", "配置 LLM(URL / Key / 模型)"],
    ["Ctrl+x c", "复制最后回答 · Ctrl+x v 复制我的问题"],
    ["长输入", "自动弹出预览窗确认(Enter 发送 · Esc 收起)"],
    ["Ctrl+x l", "会话列表 / 切换"],
    ["Ctrl+x x", "导出 Markdown 转录"],
    ["Ctrl+C ×2", "退出(仅此一种方式, Esc 不退出)"],
  ]
  return (
    <Box flexDirection="column" width="100%">
      <Text color={t.accent} bold>
        minicode
      </Text>
      <Text color={t.inkDim}>
        {cwd} · {model}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map(([k, v], i) => (
          <Box key={i} flexDirection="row">
            <Box width={11}>
              <Text color={t.inkDim}>{k}</Text>
            </Box>
            <Text color={t.inkFaint}>{v}</Text>
          </Box>
        ))}
      </Box>
      <Text color={t.inkFaint} dimColor>
        纯对话 + 命令行双模式: 模型只回文本不调用工具 · 会话缓存于项目 .minicode/ · /help 全部命令
      </Text>
    </Box>
  )
}