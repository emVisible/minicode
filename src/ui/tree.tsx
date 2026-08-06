// 任务树视图 —— 把对话侧的并行执行渲染成树
// 结构: 用户消息(根) → 每轮波次(分支) → 并行工具调用(同层兄弟)
// 同一波次的兄弟节点共享一个"波次容器", 顶部标注并行数, 状态实时着色

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { TaskNode } from "../types.ts"

export interface TreeRun {
  id: number
  prompt: string
  root: TaskNode
  /** 执行中波次序号(用于让 running 节点跳动显示) */
  activeWave?: number
  finished?: string
}

/** 从 loop 事件增量构建任务树(幂等: 同一 id 只更新状态不重建) */
export function upsertWave(root: TaskNode, wave: { n: number; parallel: boolean; calls: Array<{ id: string; tool: string; args: Record<string, unknown> }> }): void {
  let waveNode = root.children.find((c) => c.id === `wave_${wave.n}`)
  if (!waveNode) {
    waveNode = {
      id: `wave_${wave.n}`,
      label: `波次 ${wave.n}${wave.parallel ? " · 并行" : ""}`,
      status: "pending",
      children: [],
    }
    root.children.push(waveNode)
  }
  for (const call of wave.calls) {
    if (!waveNode.children.some((c) => c.id === call.id)) {
      waveNode.children.push({
        id: call.id,
        label: call.tool,
        args: call.args,
        status: "pending",
        children: [],
      })
    }
  }
}

export function updateTool(root: TaskNode, update: { id: string; tool: string; status: TaskNode["status"]; ms?: number; error?: string }): void {
  for (const wave of root.children) {
    const node = wave.children.find((c) => c.id === update.id)
    if (!node) continue
    node.status = update.status
    if (update.ms !== undefined) node.ms = update.ms
    if (update.error !== undefined) node.error = update.error
    // 任一工具 running → 波次显示为 running(⚡ 动画态)
    const anyRunning = wave.children.some((c) => c.status === "running")
    if (anyRunning) wave.status = "running"
    return
  }
}

export function markWave(root: TaskNode, n: number, status: TaskNode["status"]): void {
  const wave = root.children.find((c) => c.id === `wave_${n}`)
  if (!wave) return
  wave.status = status
}

const STATUS_SYMBOL: Record<TaskNode["status"], { char: string; color: string }> = {
  pending: { char: "○", color: "gray" },
  running: { char: "◐", color: "cyan" },
  done: { char: "✓", color: "green" },
  error: { char: "✗", color: "red" },
}

export function TaskTree({ run }: { run: TreeRun }): ReactNode {
  const root = run.root
  return (
    <Box flexDirection="column" width="100%">
      <Text color="green">你: {run.prompt}</Text>
      {root.children.length === 0 && (
        <Text color="gray">  └─ (等待任务拆解…)</Text>
      )}
      {root.children.map((wave) => {
        const parallel = wave.children.length > 1
        const doneCount = wave.children.filter((c) => c.status === "done" || c.status === "error").length
        const header =
          wave.status === "running"
            ? `${parallel ? "⚡" : "→"} 波次 ${wave.id.replace("wave_", "")}${parallel ? ` · ${wave.children.length} 并行` : ""}`
            : wave.status === "done"
              ? `✓ 波次 ${wave.id.replace("wave_", "")} (${doneCount}/${wave.children.length})`
              : `○ 波次 ${wave.id.replace("wave_", "")}`
        const headerColor = wave.status === "done" ? "green" : wave.status === "running" ? "cyan" : "gray"
        return (
          <Box key={wave.id} flexDirection="column" width="100%">
            <Text color={headerColor}>
              {"  ├─ "}
              {header}
            </Text>
            {wave.children.map((node, i) => {
              const sym = STATUS_SYMBOL[node.status]
              const isLast = i === wave.children.length - 1
              const args = node.args ? JSON.stringify(node.args).slice(0, 60) : ""
              const suffix = node.ms !== undefined ? ` (${node.ms.toFixed(0)}ms)` : ""
              const err = node.error ? ` — ${node.error.slice(0, 60)}` : ""
              return (
                <Text key={node.id} color={sym.color}>
                  {"  "}
                  {isLast ? "  └─" : "  ├─"} {sym.char} {node.label}
                  {args ? ` ${args}` : ""}
                  {suffix}
                  {err}
                </Text>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}
