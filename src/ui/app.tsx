// Ink TUI 根组件 —— 输入框 + 会话消息流 + 工具调用状态行
// 交互: Enter 提交, Esc 中断当前轮(空闲时退出), /quit 退出, /reset 清空会话

import React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Box, Text, useApp, useInput } from "ink"
import TextInput from "ink-text-input"
import { runAgent } from "../loop.ts"
import { buildSystemPrompt } from "../prompt.ts"
import { builtinTools } from "../tools.ts"
import { createLLMClient } from "../llm.ts"

import type { ChatMessage, LoopEvent, ToolDef } from "../types.ts"

interface Line {
  kind: "user" | "assistant" | "tool-start" | "tool-result" | "error"
  text: string
  /** assistant 流式文本会持续追加到同一个 line */
  stream?: boolean
}

export default function App({ cwd }: { cwd: string }): ReactNode {
  const { exit } = useApp()
  const tools = useMemo<ToolDef[]>(() => builtinTools(), [])
  const client = useMemo(() => createLLMClient(), [])
  const system = useMemo(() => buildSystemPrompt({ cwd, tools }), [cwd, tools])

  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(0)
  const [ask, setAsk] = useState<{ tool: string; summary: string } | null>(null)
  const linesRef = useRef<Line[]>([])
  const historyRef = useRef<ChatMessage[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  const askQueueRef = useRef<Array<{ req: { tool: string; summary: string }; resolve: (v: boolean) => void }>>([])

  /** 同步更新 lines state + ref, 避免流式回调闭包读到过期数组 */
  function syncLines(updater: (prev: Line[]) => Line[]): void {
    setLines((prev) => {
      const next = updater(prev)
      linesRef.current = next
      return next
    })
  }

  function appendLine(line: Line): void {
    syncLines((prev) => [...prev, line])
  }

  /** 权限确认队列: 并行工具调用可能同时触发多个 ask, 逐个展示 */
  function queueAsk(req: { tool: string; summary: string }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      askQueueRef.current.push({ req, resolve })
      if (!ask) setAsk(askQueueRef.current[0]!.req)
    })
  }

  function settleAsk(allow: boolean): void {
    const cur = askQueueRef.current.shift()
    cur?.resolve(allow)
    setAsk(askQueueRef.current[0]?.req ?? null)
  }

  function handleEvent(e: LoopEvent): void {
    switch (e.type) {
      case "step":
        setStep(e.n)
        return
      case "text": {
        syncLines((prev) => {
          const last = prev.at(-1)
          if (last && last.kind === "assistant" && last.stream) {
            const next = [...prev]
            next[next.length - 1] = { ...last, text: last.text + e.text }
            return next
          }
          return [...prev, { kind: "assistant", text: e.text, stream: true }]
        })
        return
      }
      case "tool-start":
        appendLine({ kind: "tool-start", text: `${e.tool} ${JSON.stringify(e.args).slice(0, 200)}` })
        return
      case "tool-result":
        appendLine({ kind: "tool-result", text: e.error ? `✗ ${e.tool}: ${e.error}` : `✓ ${e.tool}` })
        return
      case "done":
        return
    }
  }

  async function run(prompt: string): Promise<void> {
    setBusy(true)
    appendLine({ kind: "user", text: prompt })
    const controller = new AbortController()
    controllerRef.current = controller

    try {
      const result = await runAgent({
        history: historyRef.current,
        userMessage: { role: "user", content: prompt },
        tools,
        system,
        cwd,
        maxSteps: 30,
        signal: controller.signal,
        requests: (opts) => client.stream(opts),
        ask: queueAsk,
        onEvent: handleEvent,
      })
      historyRef.current = result.messages
      if (result.finish === "doom_loop") appendLine({ kind: "error", text: "死循环保护: 已中止同参数重复调用" })
      else if (result.finish === "aborted") appendLine({ kind: "error", text: "已中断" })
      else if (result.finish === "max_steps") appendLine({ kind: "error", text: `已达 ${result.steps} 步上限, 未完成` })
    } catch (e) {
      appendLine({ kind: "error", text: e instanceof Error ? e.message : String(e) })
    }
    // 清空未决的权限确认(中断/异常时不能让 Promise 悬空)
    for (const pending of askQueueRef.current) pending.resolve(false)
    askQueueRef.current = []
    setAsk(null)
    controllerRef.current = null
    setBusy(false)
    setStep(0)
  }

  function submit(value: string): void {
    const trimmed = value.trim()
    // 权限确认挂起时, 输入 y/n 放行或拒绝
    if (ask) {
      settleAsk(trimmed.toLowerCase() === "y" || trimmed.toLowerCase() === "yes")
      setInput("")
      return
    }
    if (!trimmed) return
    if (trimmed === "/quit" || trimmed === "/exit") {
      exit()
      return
    }
    if (trimmed === "/reset") {
      historyRef.current = []
      setLines([])
      return
    }
    if (busy) {
      appendLine({ kind: "error", text: "上一轮仍在运行, 按 Esc 中断后再输入" })
      return
    }
    setInput("")
    void run(trimmed)
  }

  useInput((_input, key) => {
    if (key.escape) {
      if (busy) controllerRef.current?.abort()
      else exit()
    }
  })

  useEffect(() => {
    appendLine({
      kind: "assistant",
      text: `MiniCode · 工作目录: ${cwd} · 模型: ${process.env.LLM_MODEL ?? "默认"} · 回车提交 / Esc 中断 / /quit 退出`,
    })
  }, [cwd])

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" alignItems="flex-start">
        {lines.map((line, i) => (
          <Text key={i} color={colorFor(line.kind)}>
            {prefixFor(line.kind)}
            {line.text}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Text color="gray">{busy ? `[${step}]` : ">"} </Text>
        {ask ? (
          <Text color="yellow" bold>
            允许 {ask.tool}? {ask.summary} (y=放行 / 其他=拒绝)
          </Text>
        ) : (
          <TextInput
            value={input}
            focus
            placeholder={busy ? "运行中…(Esc 中断)" : "输入指令"}
            onChange={setInput}
            onSubmit={submit}
          />
        )}
      </Box>
    </Box>
  )
}

function colorFor(kind: Line["kind"]): string {
  switch (kind) {
    case "user":
      return "green"
    case "assistant":
      return "white"
    case "tool-start":
      return "yellow"
    case "tool-result":
      return "magenta"
    case "error":
      return "red"
  }
}

function prefixFor(kind: Line["kind"]): string {
  switch (kind) {
    case "user":
      return "你: "
    case "tool-start":
      return "◆ "
    case "tool-result":
      return "  "
    case "assistant":
      return ""
    case "error":
      return "⚠ "
  }
}