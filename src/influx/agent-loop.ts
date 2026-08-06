// 计划内嵌对话: llm 节点的 agent 模式
// 在计划节点内运行完整 runAgent 回环(tool_calls), 把对话侧能力带进声明式批处理。
// 返回 {answer, steps, finish}; answer 取最后一条 assistant 文本。

import { builtinTools } from "../tools.ts"
import { runAgent } from "../loop.ts"
import { createLLMClient, resolveEndpoint } from "../llm.ts"
import { buildSystemPrompt } from "../prompt.ts"
import type { ToolCtx } from "./core.ts"

export interface AgentLoopOpts {
  prompt: string
  system?: string
  model?: string
  temperature?: number
  url?: string
  timeoutMs?: number
  tools: string[]
  maxSteps?: number
  ctx: ToolCtx
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<{ answer: string; steps: number; finish: string }> {
  const { prompt, system, model, temperature, url, timeoutMs = 120000, tools, maxSteps = 30, ctx } = opts
  const client = createLLMClient({ endpoint: url ? resolveEndpoint(url) : undefined, timeoutMs })

  const all = builtinTools()
  const wanted = tools.map((t) => (t.startsWith("agent.") ? t.slice("agent.".length) : t))
  const defs = all.filter((t) => wanted.includes(t.name))
  const unknown = wanted.filter((name) => !all.some((t) => t.name === name))
  if (!defs.length) throw new Error(`[llm/agent] 没有匹配的 agent 工具: ${tools.join(", ")}`)
  if (unknown.length) throw new Error(`[llm/agent] 未知工具: ${unknown.join(", ")}; 可用: ${all.map((t) => t.name).join(", ")}`)

  const result = await runAgent({
    history: [],
    userMessage: { role: "user", content: prompt },
    tools: defs,
    system: system ?? buildSystemPrompt({ cwd: ctx.cwd, tools: defs }),
    model,
    temperature,
    maxSteps,
    cwd: ctx.cwd,
    requests: (o) => client.stream(o),
    ask: ctx.ask,
    onEvent: () => {},
  })

  const answers = result.messages.filter((m) => m.role === "assistant" && !m.tool_calls?.length && m.content)
  const answer = answers.at(-1)?.content ?? ""
  return { answer, steps: result.steps, finish: result.finish }
}
