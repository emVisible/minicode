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
    ["/plan", "拆解为 DAG 并执行"],
    ["/vbuild", "声明 → 执行 → 确认落盘"],
    ["/editor", "外部编辑器撰写消息"],
    ["/sessions", "会话列表 · 输入序号恢复"],
    ["/undo /redo", "撤销 / 重做文件改动"],
    ["/connect", "配置模型连接"],
    ["/quit", "退出"],
  ]
  return (
    <Box flexDirection="column" width="100%">
      <Text color={t.accent} bold>
        minicode
      </Text>
      <Text color={t.inkDim}>
        {cwd} · {model} · {toolCount} 工具
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
        提示: @文件 补全 · !命令 直跑 shell · /help 全部命令 · ctrl+x 领衔快捷键
      </Text>
    </Box>
  )
}
