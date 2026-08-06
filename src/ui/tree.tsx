// 任务树数据层 —— 从运行事件增量构建树(幂等: 同一 id 只更新状态不重建)
// 结构: 用户消息(根) → 每轮波次(分支) → 并行工具调用(同层兄弟)
// 渲染在 activity.tsx(活动面板), 这里只做状态迁移。

import type { TaskNode } from "../types.ts"

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
