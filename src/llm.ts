// 自写 OpenAI Chat Completions SSE 流式客户端 —— 零第三方依赖
// 端点: url 参数 > LLM_URL 环境变量; 鉴权: LLM_API_KEY / API_KEY; 模型: LLM_MODEL
// 流式聚合 content / tool_calls delta, 支持超时、退避重试、AbortSignal 中断

import type { ChatMessage, LLMStreamOpts, StreamFinish, StreamResult, ToolCall, Usage } from "./types.ts"

const DEFAULT_MODEL = "gpt-4o-mini"
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_RETRIES = 2

export class LLMError extends Error {
  /** true = 可安全重试(网络/5xx/429); false = 不重试(鉴权/4xx/格式) */
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

/** 解析端点: 传入 url > LLM_URL 环境变量; 兼容已含 /chat/completions 的传入 */
export function resolveEndpoint(url?: string): string {
  const base = url ?? process.env.LLM_URL ?? process.env.API_URL
  if (!base) throw new LLMError("[llm] 未配置 LLM_URL, 请传 url 参数或注入 LLM_URL 环境变量", false)
  return base.endsWith("/chat/completions") ? base : base.replace(/\/+$/, "") + "/chat/completions"
}

export interface LLMClientOptions {
  endpoint?: string
  timeoutMs?: number
}

interface AggState {
  text: string
  calls: Map<number, { id: string; name: string; arguments: string }>
  finish: StreamFinish
  usage: Usage
}

function newState(): AggState {
  return { text: "", calls: new Map(), finish: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
}

function buildBody(opts: LLMStreamOpts): Record<string, unknown> {
  return {
    model: opts.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    messages: opts.messages,
    ...(opts.tools.length
      ? { tools: opts.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
      : {}),
    stream: true,
    temperature: opts.temperature ?? 0.2,
  }
}

export class LLMClient {
  constructor(private readonly opts: LLMClientOptions = {}) {}

  async stream(opts: LLMStreamOpts): Promise<StreamResult> {
    const endpoint = resolveEndpoint(this.opts.endpoint)
    const body = buildBody(opts)
    const apiKey = process.env.LLM_API_KEY ?? process.env.API_KEY

    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.requestOnce({ endpoint, apiKey, body, signal: opts.signal, onDelta: opts.onEvent })
      } catch (e) {
        if (e instanceof LLMError && !e.retryable) throw e
        if (opts.signal?.aborted) throw e
        lastErr = e
        if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
    }
    throw new LLMError(`[llm] 重试 ${MAX_RETRIES} 次仍失败: ${String(lastErr)}`, true)
  }

  private async requestOnce(opts: {
    endpoint: string
    apiKey?: string
    body: Record<string, unknown>
    signal?: AbortSignal
    onDelta?: (e: { type: "text-delta"; text: string }) => void
  }): Promise<StreamResult> {
    const timeoutSignal = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal

    let res: Response
    try {
      res = await fetch(opts.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(opts.body),
        signal,
      })
    } catch {
      throw signal.aborted
        ? new LLMError("[llm] 请求中断(超时或用户取消)", false)
        : new LLMError("[llm] 网络错误", true)
    }

    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => "")
      throw new LLMError(`[llm] 鉴权失败 HTTP ${res.status}: ${t.slice(0, 200)}`, false)
    }
    if (res.status >= 400) {
      const t = await res.text().catch(() => "")
      throw new LLMError(`[llm] HTTP ${res.status}: ${t.slice(0, 300)}`, res.status >= 500 || res.status === 429)
    }

    const state = newState()
    const ctype = res.headers.get("content-type") ?? ""
    if (ctype.includes("application/json") && !ctype.includes("text/event-stream")) {
      // 兼容不支持 stream 的 provider 子集: 一次返回完整 JSON
      const json: any = await res.json()
      const msg = json.choices?.[0]?.message
      return {
        message: { role: "assistant", content: msg?.content ?? "", ...(msg?.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) },
        finish: (json.choices?.[0]?.finish_reason as StreamFinish) ?? "stop",
        usage: toUsage(json),
      }
    }

    await this.readSSE(res, state, opts.onDelta)
    const calls = [...state.calls.values()]
      .filter((c) => c.name)
      .map((c): ToolCall => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
    return {
      message: { role: "assistant", content: state.text, ...(calls.length ? { tool_calls: calls } : {}) },
      finish: state.finish,
      usage: state.usage,
    }
  }

  private async readSSE(
    res: Response,
    state: AggState,
    onDelta?: (e: { type: "text-delta"; text: string }) => void,
  ): Promise<void> {
    if (!res.body) throw new LLMError("[llm] 响应体为空", true)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    const flushLine = (line: string) => {
      const idx = line.indexOf(":")
      if (idx === -1) return
      const key = line.slice(0, idx)
      let data = line.slice(idx + 1)
      if (data.startsWith(" ")) data = data.slice(1)
      if (key !== "data" || !data || data === "[DONE]") return
      this.parseChunk(state, data, onDelta)
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        flushLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
      }
    }
    if (buffer.length) flushLine(buffer)
  }

  private parseChunk(
    state: AggState,
    data: string,
    onDelta?: (e: { type: "text-delta"; text: string }) => void,
  ): void {
    let json: any
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    const choice = json.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) {
      state.text += delta.content
      onDelta?.({ type: "text-delta", text: delta.content })
    }
    for (const raw of delta?.tool_calls ?? []) {
      const call = state.calls.get(raw.index) ?? { id: "", name: "", arguments: "" }
      if (raw.id) call.id = raw.id
      if (raw.function?.name) call.name = raw.function.name
      if (raw.function?.arguments) call.arguments += raw.function.arguments
      state.calls.set(raw.index, call)
    }
    if (choice?.finish_reason) state.finish = choice.finish_reason as StreamFinish
    if (json.usage) state.usage = toUsage(json)
  }
}

function toUsage(raw: any): Usage {
  const u = raw?.usage
  return {
    inputTokens: u?.prompt_tokens ?? u?.input_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? u?.output_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
  }
}

/** 便捷工厂: createLLMClient({ endpoint }) */
export function createLLMClient(opts?: LLMClientOptions): LLMClient {
  return new LLMClient(opts)
}

export type { ChatMessage }