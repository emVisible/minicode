// Agent 主循环 —— 对话式 tool-call 回环
// 输入一轮会话, 循环: 请求 LLM → 有 tool_calls 则逐一执行并回喂 → 直到无 tool_calls 或达上限
// 与 UI 解耦: onEvent 回调暴露流式文本/工具执行, 供 TUI 与 headless 复用

import type { ChatMessage, LoopEvent, LoopOptions, ToolSpec } from "./types.ts"

const DEFAULT_MAX_STEPS = 30
const DOOM_LOOP_THRESHOLD = 3

/** 循环输入: 一次 runAgent 调用处理一条 user 消息及其后续所有工具回环 */
export type RunInput = LoopOptions & {
  history: ChatMessage[]
  userMessage: ChatMessage
}

export interface RunResult {
  /** 处理后完整会话(含 assistant 文本与所有 tool 回执), 可直接作为下一轮 history */
  messages: ChatMessage[]
  finish: "stop" | "max_steps" | "aborted" | "doom_loop"
  steps: number
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { onEvent, signal, maxSteps = DEFAULT_MAX_STEPS } = input
  const messages: ChatMessage[] = [...input.history, input.userMessage]
  const toolMap = new Map(input.tools.map((t) => [t.name, t]))
  const specs: ToolSpec[] = input.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
  const doomCounts = new Map<string, number>()
  let steps = 0

  while (true) {
    if (signal?.aborted) return { messages, finish: "aborted", steps }
    if (steps >= maxSteps) return { messages, finish: "max_steps", steps }
    steps++
    onEvent?.({ type: "step", n: steps })

    const req = await input.requests({
      messages: [{ role: "system", content: input.system }, ...messages],
      tools: specs,
      signal,
      onEvent: (e) => {
        if (e.type === "text-delta") onEvent?.({ type: "text", text: e.text })
      },
    })
    messages.push(req.message)

    const calls = req.message.tool_calls
    if (!calls?.length) {
      onEvent?.({ type: "done", finish: req.finish })
      return { messages, finish: "stop", steps }
    }

    // doom-loop 保护: 同工具同一参数连续 N 次视为死循环
    for (const call of calls) {
      const key = `${call.function.name}:${call.function.arguments}`
      const n = (doomCounts.get(key) ?? 0) + 1
      doomCounts.set(key, n)
      if (n >= DOOM_LOOP_THRESHOLD) {
        messages.push({
          role: "assistant",
          content: `检测到死循环: 工具 ${call.function.name} 以相同参数连续调用 ${n} 次, 已中止。请换一种方式。`,
        })
        return { messages, finish: "doom_loop", steps }
      }
    }

    for (const call of calls) {
      const tool = toolMap.get(call.function.name)
      if (!tool) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `工具不存在: ${call.function.name}。可用工具: ${[...toolMap.keys()].join(", ")}`,
        })
        continue
      }
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(call.function.arguments || "{}")
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("参数必须是对象")
      } catch (e) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `参数解析失败: ${String((e as Error).message)}。请重新提供合法的 JSON 参数。`,
        })
        continue
      }

      onEvent?.({ type: "tool-start", tool: tool.name, args: parsed })
      try {
        const out = await tool.execute(parsed, {
          cwd: input.cwd,
          signal,
          ask: input.ask,
        })
        messages.push({ role: "tool", tool_call_id: call.id, content: out.output })
        onEvent?.({ type: "tool-result", tool: tool.name })
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        messages.push({ role: "tool", tool_call_id: call.id, content: `工具错误: ${errMsg}` })
        onEvent?.({ type: "tool-result", tool: tool.name, error: errMsg })
      }
    }
  }
}