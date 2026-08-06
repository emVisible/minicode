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
  /** VBuild 虚拟文件系统: 存在时 write/edit 写入内存 overlay, 由 RBuild 统一落盘 */
  vfs?: import("./vfs.ts").VFS
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
  /** 流式诊断: 首 token 延迟 ms(网络+模型思考)与平均速率 tokens/s */
  ttft?: number
  tps?: number
}

// ---------- 任务树 ----------
// 对话侧执行的可视化数据结构: 每一轮 LLM 回复 = 一个波次(兄弟节点并行),
// 波次间串行推进。UI 用它渲染"并行看得见"的树。

export type TaskStatus = "pending" | "running" | "done" | "error"

export interface TaskNode {
  /** 稳定 id: tool_call.id 或自动生成 */
  id: string
  /** 工具名或描述(根/波次节点用) */
  label: string
  /** 执行参数(截断显示用) */
  args?: Record<string, unknown>
  status: TaskStatus
  ms?: number
  error?: string
  children: TaskNode[]
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
  /** VBuild 虚拟文件系统: 传入后 write/edit 进 overlay, RBuild 统一落盘 */
  vfs?: import("./vfs.ts").VFS
}

export type LoopEvent =
  | { type: "step"; n: number }
  | { type: "text"; text: string }
  | { type: "wave-start"; n: number; parallel: boolean; calls: Array<{ id: string; tool: string; args: Record<string, unknown> }> }
  | { type: "tool-start"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; id: string; tool: string; ms: number; error?: string }
  | { type: "wave-end"; n: number; ms: number }
  | { type: "done"; finish: string }