// MiniCode 共享类型 —— 单一真相源类型层, 供 llm / cli / ui / test 共用

// ---------- LLM 会话消息 ----------

export type Role = "system" | "user" | "assistant"

/** OpenAI Chat Completions 兼容消息(纯文本, 无工具) */
export interface ChatMessage {
  role: Role
  content: string
}

// ---------- LLM 流事件 ----------

export type StreamFinish = "stop" | "length" | "content_filter" | "error" | "aborted"

export type StreamEvent = { type: "text-delta"; text: string }

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface LLMStreamOpts {
  messages: ChatMessage[]
  model?: string
  temperature?: number
  signal?: AbortSignal
  onEvent?: (e: StreamEvent) => void
}

export interface StreamResult {
  message: ChatMessage
  finish: StreamFinish
  usage: Usage
  /** 流式诊断: 首 token 延迟 ms(网络+模型思考)与平均速率 tokens/s */
  ttft?: number
  tps?: number
}

// ---------- 对话流结构化消息 ----------

export type ChatMsg =
  | { kind: "user"; text: string; ts: number }
  | { kind: "assistant"; text: string; ts: number }
  | { kind: "verdict"; text: string; ok: boolean; detail?: string[]; ts: number }
  | { kind: "danger"; text: string; detail?: string[]; ts: number }
  | { kind: "info"; text: string; detail?: string[]; ts: number }

/** 诊断托盘条目(Ctrl+d 展开, 默认折叠为细字) */
export interface DiagLine {
  ts: number
  level: "info" | "warn" | "err"
  text: string
}
