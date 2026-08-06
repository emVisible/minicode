// MiniCode 共享类型 —— 单一真相源类型层, 供 llm / loop / cli / test 共用

// ---------- LLM 会话消息 ----------

export type Role = "system" | "user" | "assistant" | "tool"

/** OpenAI Chat Completions 兼容消息(M1 仅文本 content) */
export interface ChatMessage {
  role: Role
  content: string
  /** assistant 消息带 tool_calls 时存在 */
  tool_calls?: ToolCall[]
  /** tool 消息回执用: 对应 assistant tool_call 的 id */
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    /** JSON 字符串, 按 OpenAI 会话格式传递 */
    arguments: string
  }
}

// ---------- 工具定义 ----------

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema 对象, 直接下发给模型 */
  parameters: Record<string, unknown>
}

export interface ToolRunContext {
  cwd: string
  signal?: AbortSignal
  /** 写类工具在 ask 模式下执行前回调, 返回 true 才放行 */
  ask: (req: { tool: string; summary: string }) => Promise<boolean>
}

export interface ToolOutput {
  output: string
}

export interface ToolDef extends ToolSpec {
  execute: (args: Record<string, unknown>, ctx: ToolRunContext) => Promise<ToolOutput>
}

// ---------- LLM 流事件 ----------

export type StreamFinish = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "aborted"

export type StreamEvent = { type: "text-delta"; text: string }

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface LLMStreamOpts {
  messages: ChatMessage[]
  tools: ToolSpec[]
  model?: string
  temperature?: number
  signal?: AbortSignal
  onEvent?: (e: StreamEvent) => void
}

export interface StreamResult {
  /** assistant 消息(含已累积文本与 tool_calls) */
  message: ChatMessage
  finish: StreamFinish
  usage: Usage
}

export interface StreamResult {
  /** assistant 消息(含已累积文本与 tool_calls) */
  message: ChatMessage
  finish: StreamFinish
  usage: Usage
}

// ---------- 循环 ----------

export interface LoopOptions {
  cwd: string
  tools: ToolDef[]
  system: string
  model?: string
  temperature?: number
  maxSteps?: number
  requests: (opts: LLMStreamOpts) => Promise<StreamResult>
  ask: (req: { tool: string; summary: string }) => Promise<boolean>
  signal?: AbortSignal
  onEvent?: (e: LoopEvent) => void
}

export type LoopEvent =
  | { type: "step"; n: number }
  | { type: "text"; text: string }
  | { type: "tool-start"; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; tool: string; error?: string }
  | { type: "done"; finish: string }