// 反向桥接: 对话侧 agent 工具(read/write/edit/glob/grep/bash)注册进计划注册表
// 计划节点可直接使用 agent.read / agent.write 等; llm 节点的 agent 模式复用同一份定义
//
// 与 src/tools.ts 的依赖是运行时懒加载, 避免循环: src/tools.ts 顶部 import 了 influx 的 getTool

import { registerTool, getTool } from "./tools.ts"
import type { ToolCtx } from "./core.ts"

let registered = false

/** 把对话工具桥接为计划工具(agent.<name>), 幂等; 计划运行前调用一次 */
export async function ensureAgentTools(): Promise<void> {
  if (registered) return
  registered = true
  const { builtinTools } = await import("../tools.ts")
  for (const def of builtinTools()) {
    const name = `agent.${def.name}`
    if (isRegistered(name)) continue
    registerTool(
      name,
      async (params, ctx: ToolCtx) => {
        const out = await def.execute(params, { cwd: ctx.cwd, ask: ctx.ask })
        return out.output
      },
      `${def.description.split("\n")[0]} (桥接自对话 agent 工具)`,
    )
  }
}

function isRegistered(name: string): boolean {
  try {
    getTool(name)
    return true
  } catch {
    return false
  }
}
