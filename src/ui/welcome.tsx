// 启动欢迎卡片 —— 极简 wordmark + 命令网格(Apple 式: 无边框, 排印表达层级)
// 只渲染一次(首个会话消息前), 随对话滚动到上方

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { ThemeTokens } from "./theme.ts"

export function WelcomeCard(props: { cwd: string; model: string; toolCount: number; t: ThemeTokens }): ReactNode {
  const { cwd, model, toolCount, t } = props
  const rows: Array<[string, string]> = [
    ["Tab", "Plan / Build 模式切换"],
    ["/plan", "LLM 拆解为并行 DAG 并执行"],
    ["/vbuild", "虚拟构建 → 确认后落盘"],
    ["/config", "配置模型连接"],
    ["/reset", "清空会话"],
    ["/quit", "退出"],
    ["Ctrl+o", "设置面板"],
  ]
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" paddingY={1}>
        <Text color={t.accent} bold>
          minicode
        </Text>
        <Text color={t.inkDim}>
          {cwd} · {model} · {toolCount} 工具
        </Text>
      </Box>
      <Box flexDirection="column">
        {rows.map(([k, v], i) => (
          <Box key={i} flexDirection="row">
            <Box width={11}>
              <Text color={t.inkDim}>{k}</Text>
            </Box>
            <Text color={t.inkFaint}>{v}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={t.inkDim}>输入指令开始。Tab 切换 Plan(先想)/Build(动手)两种模式。</Text>
      </Box>
    </Box>
  )
}
