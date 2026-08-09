// 自写 OpenAI Chat Completions SSE 流式客户端 —— 零第三方依赖
// 端点: url 参数 > LLM_URL 环境变量; 鉴权: LLM_API_KEY / API_KEY; 模型: LLM_MODEL
// 纯文本流式聚合 content, 支持超时、退避重试、AbortSignal 中断

import type { ChatMessage, LLMStreamOpts, StreamFinish, StreamResult, Usage } from "./types.ts"

const DEFAULT_MODEL = "gpt-4o-mini"
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_RETRIES = 3

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

function buildBody(opts: LLMStreamOpts): Record<string, unknown> {
  return {
    model: opts.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.7,
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

    const t0 = performance.now()
    let firstTokenAt = 0
    const ctype = res.headers.get("content-type") ?? ""
    if (ctype.includes("application/json") && !ctype.includes("text/event-stream")) {
      // 兼容不支持 stream 的 provider 子集: 一次返回完整 JSON
      const json: any = await res.json()
      const msg = json.choices?.[0]?.message
      const ttft = performance.now() - t0
      const usage = toUsage(json)
      return {
        message: { role: "assistant", content: msg?.content ?? "" },
        finish: (json.choices?.[0]?.finish_reason as StreamFinish) ?? "stop",
        usage,
        ttft,
        tps: usage.outputTokens > 0 && ttft > 0 ? (usage.outputTokens / ttft) * 1000 : undefined,
      }
    }

    let text = ""
    let finish: StreamFinish = "stop"
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

    const timedDelta = (e: { type: "text-delta"; text: string }) => {
      if (!firstTokenAt) firstTokenAt = performance.now()
      opts.onDelta?.(e)
    }
    await this.readSSE(res, {
      onDelta: timedDelta,
      onText: (t) => (text += t),
      onFinish: (f) => (finish = f),
      onUsage: (u) => (usage = u),
    })
    const total = performance.now() - t0
    const ttft = firstTokenAt ? firstTokenAt - t0 : total
    const outTokens = text.length / 4
    return {
      message: { role: "assistant", content: text },
      finish,
      usage,
      ttft,
      tps: outTokens > 0 && total - ttft > 0 ? (outTokens / (total - ttft)) * 1000 : undefined,
    }
  }

  private async readSSE(
    res: Response,
    handlers: {
      onDelta: (e: { type: "text-delta"; text: string }) => void
      onText: (t: string) => void
      onFinish: (f: StreamFinish) => void
      onUsage: (u: Usage) => void
    },
  ): Promise<void> {
    if (!res.body) throw new LLMError("[llm] 响应体为空", true)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    // idle 超时: 流开始后 45s 无数据(服务器挂起/网络断开) → 报错而不是无限等
    const IDLE_TIMEOUT_MS = 45_000
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let idleFired = false
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleFired = true
        void reader.cancel().catch(() => {})
      }, IDLE_TIMEOUT_MS)
    }
    armIdle()

    const flushLine = (line: string) => {
      const idx = line.indexOf(":")
      if (idx === -1) return
      const key = line.slice(0, idx)
      let data = line.slice(idx + 1)
      if (data.startsWith(" ")) data = data.slice(1)
      if (key !== "data" || !data || data === "[DONE]") return
      this.parseChunk(data, handlers)
    }

    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch {
          if (idleFired) throw new LLMError("[llm] 流式响应 45s 无数据(服务器挂起?), 已中断", true)
          throw new LLMError("[llm] 流式读取中断", true)
        }
        if (chunk.done) break
        armIdle()
        buffer += decoder.decode(chunk.value, { stream: true })
        let nl = buffer.indexOf("\n")
        while (nl !== -1) {
          flushLine(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf("\n")
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
    }
    if (buffer.length) flushLine(buffer)
  }

  private parseChunk(
    data: string,
    handlers: {
      onDelta: (e: { type: "text-delta"; text: string }) => void
      onText: (t: string) => void
      onFinish: (f: StreamFinish) => void
      onUsage: (u: Usage) => void
    },
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
      handlers.onText(delta.content)
      handlers.onDelta({ type: "text-delta", text: delta.content })
    }
    if (choice?.finish_reason) handlers.onFinish(choice.finish_reason as StreamFinish)
    if (json.usage) handlers.onUsage(toUsage(json))
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
