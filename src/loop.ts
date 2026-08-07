// Agent 主循环 —— 对话式 tool-call 回环
// 输入一轮会话, 循环: 请求 LLM → 有 tool_calls 则逐一执行并回喂 → 直到无 tool_calls 或达上限
// 与 UI 解耦: onEvent 回调暴露流式文本/工具执行, 供 TUI 与 headless 复用

import type { ChatMessage, LoopEvent, LoopOptions, ToolSpec } from "./types.ts"
import { log } from "./log.ts"

const DEFAULT_MAX_STEPS = 30
/** 同参数连续调用达到该次数时先注入警告(给模型一次换方式的机会) */
const DOOM_WARN_THRESHOLD = 3
/** 警告后仍继续相同调用达到该次数才硬中止(真死循环) */
const DOOM_ABORT_THRESHOLD = 4
/** 单次请求的上下文预算; 超限时丢弃最旧的非 system 消息 */
const MAX_CONTEXT_BYTES = 128 * 1024
/** 只读停滞守卫: 连续 N 轮没有任何写类调用时注入催促(模型经常纯读探索不动手) */
const READONLY_NUDGE_ROUNDS = 6
/** 写类工具: 修改代码才算推进任务(bash/shell 视为动作, 不算写) */
const WRITE_TOOLS = new Set(["write", "edit", "append", "patch"])

/** 上下文压缩: 序列化体积超预算时, 保留 system + 最新消息, 丢弃最旧消息并注入截断标记 */
function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  const size = () => JSON.stringify(messages).length
  if (size() <= MAX_CONTEXT_BYTES) return messages

  const out = [...messages]
  while (out.length > 0 && size() > MAX_CONTEXT_BYTES) {
    const i = out.findIndex((m) => m.role !== "system")
    if (i === -1) break
    out.splice(i, 1)
  }

  const dropped = messages.length - out.length
  if (dropped > 0) {
    out.push({
      role: "system",
      content: `[上下文截断] 因体积超限已丢弃最早 ${dropped} 条消息, 保留最近 ${out.length} 条。`,
    })
  }
  return out
}

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
  /** 本轮实际执行的写类调用次数(write/edit/append/patch) */
  writes: number
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { onEvent, signal, maxSteps = DEFAULT_MAX_STEPS } = input
  const messages: ChatMessage[] = [...input.history, input.userMessage]
  const toolMap = new Map(input.tools.map((t) => [t.name, t]))
  const specs: ToolSpec[] = input.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
  let lastBatchKey = ""
  let consecutive = 0
  let steps = 0
  let writes = 0
  /** 自最近一次写类调用以来的只读轮数(停滞守卫) */
  let readOnlySinceWrite = 0
  let nudgeInjected = false

  while (true) {
    if (signal?.aborted) return { messages, finish: "aborted", steps, writes }
    if (steps >= maxSteps) return { messages, finish: "max_steps", steps, writes }
    steps++
    onEvent?.({ type: "step", n: steps })

    const req = await input.requests({
      messages: [{ role: "system", content: input.system }, ...compactMessages(messages)],
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
      log.info("agent", `完成, ${steps} 步`, { finish: req.finish })
      return { messages, finish: "stop", steps, writes }
    }

    // doom-loop 保护: 以「整批调用签名」为单位比较, 而不是单个调用。
    // 原因: 模型在并行波次里常常重复参数(如一步里并行 read 同一文件两次),
    // 按调用逐个计数会把「一个波次内的冗余」误算成连续重复, 两步就触发中止。
    // 现在: 只有整批调用与上一批完全一致(真循环)才 +1; 波次内重复不再累积。
    // 分级: 连续 3 次先注入警告(模型可能只是没注意到), 警告后仍重复才中止。
    const batchKey = calls.map((c) => `${c.function.name}:${c.function.arguments}`).join("\u0000")
    consecutive = batchKey === lastBatchKey ? consecutive + 1 : 1
    lastBatchKey = batchKey
    const first = calls[0]!
    if (consecutive >= DOOM_ABORT_THRESHOLD) {
      log.warn("agent", "死循环保护中止", { tool: first.function.name, consecutive, batchKey: batchKey.slice(0, 200) })
      messages.push({
        role: "assistant",
        content: `检测到死循环: 工具 ${first.function.name} 以相同参数连续 ${consecutive} 波次重复调用(警告后仍未改变), 已中止。请换一种方式。`,
      })
      return { messages, finish: "doom_loop", steps, writes }
    }
    if (consecutive === DOOM_WARN_THRESHOLD) {
      log.warn("agent", "死循环警告", { tool: first.function.name, consecutive })
      // 针对常见循环的具体建议, 引导模型走出重复
      const hint =
        first.function.name === "read"
          ? "该路径可能已读取过, 请直接基于已有内容继续(修改/写入/总结), 或改用 glob/grep 精确定位"
          : first.function.name === "bash"
            ? "该命令可能未达到预期, 请检查上一步输出并换一个命令, 不要原样重跑"
            : "请基于已有结果继续下一步, 不要重复相同调用"
      messages.push({
        role: "assistant",
        content: `提示: 工具 ${first.function.name} 已连续 ${consecutive} 个波次使用相同参数调用, 疑似重复。${hint}。若再重复相同调用将中止任务。`,
      })
    }

    // 本轮所有 tool_calls 是一个"波次"(树的同一层): 兄弟节点并行执行
    const waveStart = performance.now()
    const callMeta = calls.map((call, i) => ({
      call,
      id: call.id || `call_${steps}_${i}`,
      tool: call.function.name,
      args: safeParseArgs(call.function.arguments),
    }))
    onEvent?.({
      type: "wave-start",
      n: steps,
      parallel: callMeta.length > 1,
      calls: callMeta.map(({ id, tool, args }) => ({ id, tool, args })),
    })
    log.debug("agent", `波次 ${steps}`, { parallel: callMeta.length > 1, calls: callMeta.map((c) => c.tool) })

    // 只读停滞守卫: 连续多轮没有任何写调用时, 注入催促让模型动手(而不是继续纯读/询问)。
    // 只注入一次, 给模型一次修正机会; 若仍不写, 由上层(writes=0)如实报告"未修改任何文件"。
    const hasWrite = callMeta.some((c) => WRITE_TOOLS.has(c.tool))
    if (hasWrite) {
      writes++
      readOnlySinceWrite = 0
    } else {
      readOnlySinceWrite++
      if (!nudgeInjected && readOnlySinceWrite >= READONLY_NUDGE_ROUNDS) {
        nudgeInjected = true
        log.warn("agent", "只读停滞催促", { steps, readOnlyRounds: readOnlySinceWrite })
        messages.push({
          role: "system",
          content:
            `[执行提醒] 你已连续 ${readOnlySinceWrite} 轮只读/询问, 尚未修改任何文件。` +
            `任务要求实际产出: 现在必须用 write 重写目标文件完成改动, 或用 bash 执行构建/测试验证。` +
            `不要继续只读探索, 不要向用户提问。`,
        })
      }
    }

    const results = await Promise.all(
      callMeta.map(async ({ call, id, tool, args }) => {
        const toolDef = toolMap.get(tool)
        if (!toolDef) {
          return { id, tool, ms: 0, error: undefined, content: `工具不存在: ${tool}。可用工具: ${[...toolMap.keys()].join(", ")}` }
        }
        if (args.rawError) {
          return { id, tool, ms: 0, error: undefined, content: `参数解析失败: ${args.rawError}。请重新提供合法的 JSON 参数。` }
        }
        onEvent?.({ type: "tool-start", id, tool, args })
        const t0 = performance.now()
        try {
          const out = await toolDef.execute(args, {
            cwd: input.cwd,
            signal,
            ask: input.ask,
            ...(input.vfs ? { vfs: input.vfs } : {}),
            // bash 等流式工具: 实时回传执行输出(对话流同步可见)
            onStream: (text: string) => onEvent?.({ type: "text", text: text.slice(-500) }),
          })
          const ms = performance.now() - t0
          onEvent?.({ type: "tool-result", id, tool, ms })
          log.debug("agent", `工具成功 ${tool}`, { id, ms })
          return { id, tool, ms, error: undefined, content: out.output }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          const ms = performance.now() - t0
          onEvent?.({ type: "tool-result", id, tool, ms, error: errMsg })
          log.warn("agent", `工具失败 ${tool}`, { id, ms, error: errMsg.slice(0, 500) })
          return { id, tool, ms, error: errMsg, content: `工具错误: ${errMsg}` }
        }
      }),
    )
    onEvent?.({ type: "wave-end", n: steps, ms: performance.now() - waveStart })
    results.forEach(({ id, content }) => {
      messages.push({ role: "tool", tool_call_id: id, content })
    })
  }
}

/** 解析 tool_call 参数; 失败时返回 rawError 标记, 由执行方转成回喂消息 */
function safeParseArgs(raw: string): Record<string, unknown> & { rawError?: string } {
  try {
    const parsed = JSON.parse(raw || "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("参数必须是对象")
    return parsed
  } catch (e) {
    return { rawError: String((e as Error).message) }
  }
}