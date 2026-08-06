// 启动欢迎卡片 —— 信息面板 + 命令速查, 简约居中风格
// 只渲染一次(首个会话消息前), 随对话滚动到上方

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"

export function WelcomeCard(props: { cwd: string; model: string; toolCount: number }): ReactNode {
  const { cwd, model, toolCount } = props
  return (
    <Box flexDirection="column" width="100%">
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        width="100%"
      >
        <Box flexDirection="row" alignItems="center">
          <Text bold color="cyan">
            MiniCode
          </Text>
          <Text color="gray"> · 双引擎编码 agent · v0.4</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Text color="gray">目录 </Text>
            <Text color="white">{cwd}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="gray">模型 </Text>
            <Text color="white">{model}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="gray">工具 </Text>
            <Text color="white">{toolCount} 个</Text>
            <Text color="gray"> · 计划运行时 · VBuild/RBuild · MCP</Text>
          </Box>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Ctrl+o 设置 · /config 配置</Text>
          <Text color="gray">/plan 任务拆解全并行 · /vbuild 两段式构建</Text>
          <Text color="gray">/reset 清空会话 · /quit 退出</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">输入指令, Enter 提交。复杂任务会自动拆解为并行 DAG 执行。</Text>
      </Box>
    </Box>
  )
}
