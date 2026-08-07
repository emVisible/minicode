// 反向桥接: 对话侧 agent 工具(read/write/edit/glob/grep/bash)注册进计划注册表
// 计划节点可直接使用 agent.read / agent.write 等; llm 节点的 agent 模式复用同一份定义
//
// 与 src/tools.ts 的依赖是运行时懒加载, 避免循环: src/tools.ts 顶部 import 了 influx 的 getTool

import { registerTool, getTool } from "./tools.ts"
import type { ToolCtx } from "./core.ts"

let registered = false

/** 净化对话工具输出: 去掉 <path>/<type>/<content|entries> XML 包装与行号前缀, 只留正文 */
function cleanOutput(raw: string): string {
  const m = raw.match(/<(content|entries)>\n([\s\S]*)\n<\/\1>/)
  let body = m?.[2] ?? raw
  // read 工具带 "1: xxx" 行号前缀, 供模型引用时去掉
  if (/^\d+: /.test(body)) {
    const lines = body.split("\n")
    if (lines.every((l) => /^\d+: /.test(l))) {
      body = lines.map((l) => l.replace(/^\d+: /, "")).join("\n")
    }
  }
  return body
}

/** 把对话工具桥接为计划工具(agent.<name>), 幂等; 计划运行前调用一次 */
export async function ensureAgentTools(): Promise<void> {
  if (registered) return
  const { builtinTools } = await import("../tools.ts")
  for (const def of builtinTools()) {
    const name = `agent.${def.name}`
    if (isRegistered(name)) continue
    registerTool(
      name,
      async (params, ctx: ToolCtx) => {
        const out = await def.execute(params, {
          cwd: ctx.cwd,
          ask: ctx.ask,
          ...(ctx.vfs ? { vfs: ctx.vfs } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          // bash 实时输出桥接: 计划节点运行中即可见命令输出
          ...(ctx.onStream ? { onStream: (text: string) => ctx.onStream?.(ctx.key ?? name, text) } : {}),
        })
        // 结构化返回: 净化后的正文放 output, 支持 {$k} 与 {$k.output} 两种引用
        return { output: cleanOutput(out.output) }
      },
      `${def.description.split("\n")[0]} (桥接自对话 agent 工具)`,
    )
  }
  // 全部注册成功后才标记, 避免中途失败永久跳过
  registered = true
}

function isRegistered(name: string): boolean {
  try {
    getTool(name)
    return true
  } catch {
    return false
  }
}
