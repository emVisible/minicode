// Ink TUI 根组件 —— 输入框 + 会话消息流 + 工具调用状态行 + 设置面板
// 交互: Enter 提交, Esc 中断当前轮(空闲时退出), /quit 退出, /reset 清空会话
// 设置: Ctrl+o 或 /config 呼出设置面板(配置 LLM_URL / API Key / Model, 保存即生效并持久化)

import React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Box, Text, useApp, useInput } from "ink"
import TextInput from "ink-text-input"
import { runAgent } from "../loop.ts"
import { buildSystemPrompt } from "../prompt.ts"
import { builtinTools } from "../tools.ts"
import { createLLMClient } from "../llm.ts"
import { saveConfig, applyConfigToEnv, configPath } from "../config.ts"
import { SettingsPanel } from "./settings.tsx"
import { TaskTree, upsertWave, updateTool, markWave } from "./tree.tsx"
import type { MinicodeConfig } from "../config.ts"
import type { ChatMessage, LoopEvent, TaskNode, ToolDef } from "../types.ts"

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
  const [spinner, setSpinner] = useState(0)
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [ask, setAsk] = useState<{ tool: string; summary: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [configDraft, setConfigDraft] = useState<MinicodeConfig>({})
  const [configField, setConfigField] = useState(0)
  const linesRef = useRef<Line[]>([])
  const historyRef = useRef<ChatMessage[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  const askQueueRef = useRef<Array<{ req: { tool: string; summary: string }; resolve: (v: boolean) => void }>>([])
  /** 流式文本节流: SSE delta 频繁到来, 批量合并后按帧渲染, 避免每 chunk 一次全量 setState */
  const streamBufRef = useRef("")
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const STREAM_FLUSH_MS = 30
  /** 并行工具计数: 显示当前同时在跑的工具数, 让并发可视化 */
  const runningToolsRef = useRef(0)
  const [runningTools, setRunningTools] = useState(0)
  /** 当前运行的任务树(增量更新, 不重建) */
  const treeRef = useRef<TaskNode | null>(null)
  const [tree, setTree] = useState<TaskNode | null>(null)
  const [treePrompt, setTreePrompt] = useState("")

  /** 同步更新 lines state + ref。注意: updater 必须保持纯函数(React 可能多次调用),
   *  ref 的同步放到 useEffect 里做, 避免在 updater 内产生副作用 */
  function syncLines(updater: (prev: Line[]) => Line[]): void {
    setLines(updater)
  }

  useEffect(() => {
    linesRef.current = lines
  }, [lines])

  function appendLine(line: Line): void {
    setLines((prev) => [...prev, line])
  }

  /** 把节流缓冲的流式文本一次性提交到状态并渲染 */
  function flushStream(): void {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current)
      streamTimerRef.current = null
    }
    const text = streamBufRef.current
    if (!text) return
    streamBufRef.current = ""
    setLines((prev) => {
      const last = prev.at(-1)
      if (last && last.kind === "assistant" && last.stream) {
        const next = [...prev]
        next[next.length - 1] = { ...last, text: last.text + text }
        return next
      }
      return [...prev, { kind: "assistant", text, stream: true }]
    })
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

  /** 打开设置面板: 从当前环境快照编辑草稿; 清掉 Ctrl+o 可能被 TextInput 吞入的字符 */
  function openConfig(): void {
    setInput("")
    setConfigDraft({
      llmUrl: process.env.LLM_URL ?? process.env.API_URL ?? "",
      llmApiKey: process.env.LLM_API_KEY ?? process.env.API_KEY ?? "",
      llmModel: process.env.LLM_MODEL ?? "",
    })
    setConfigField(0)
    setSettingsOpen(true)
  }

  /** 保存设置: 写配置 + 注入环境变量(立即生效) */
  function saveConfigPanel(): void {
    const cfg: MinicodeConfig = {
      llmUrl: configDraft.llmUrl?.trim() || undefined,
      llmApiKey: configDraft.llmApiKey?.trim() || undefined,
      llmModel: configDraft.llmModel?.trim() || undefined,
    }
    saveConfig(cfg)
    applyConfigToEnv(cfg)
    setSettingsOpen(false)
    setInput("")
    appendLine({
      kind: "tool-result",
      text: `✓ 设置已保存并生效 (${configPath()})`,
    })
  }

  const CONFIG_FIELDS: Array<{ key: keyof MinicodeConfig; label: string; placeholder: string; secret?: boolean }> = [
    { key: "llmUrl", label: "LLM URL", placeholder: "https://api.openai.com/v1" },
    { key: "llmApiKey", label: "API Key", placeholder: "sk-...", secret: true },
    { key: "llmModel", label: "Model", placeholder: "gpt-4o-mini" },
  ]

  /** 触发一次树渲染(节流: 高频状态变更合并到同一帧) */
  function bumpTree(): void {
    const t = treeRef.current
    if (t) setTree({ ...t, children: [...t.children] })
  }

  function handleEvent(e: LoopEvent): void {
    switch (e.type) {
      case "step":
        flushStream()
        setStep(e.n)
        return
      case "text": {
        // 只累积到缓冲区, 由定时器批量提交, 防止高频 setState
        streamBufRef.current += e.text
        if (!streamTimerRef.current) {
          streamTimerRef.current = setTimeout(flushStream, STREAM_FLUSH_MS)
        }
        return
      }
      case "wave-start": {
        flushStream()
        if (treeRef.current) {
          upsertWave(treeRef.current, e)
          bumpTree()
        }
        return
      }
      case "tool-start": {
        flushStream()
        runningToolsRef.current++
        setRunningTools(runningToolsRef.current)
        if (treeRef.current) {
          updateTool(treeRef.current, { id: e.id, tool: e.tool, status: "running" })
          bumpTree()
        }
        return
      }
      case "tool-result": {
        flushStream()
        runningToolsRef.current = Math.max(0, runningToolsRef.current - 1)
        setRunningTools(runningToolsRef.current)
        if (treeRef.current) {
          updateTool(treeRef.current, {
            id: e.id,
            tool: e.tool,
            status: e.error ? "error" : "done",
            ms: e.ms,
            error: e.error,
          })
          bumpTree()
        }
        return
      }
      case "wave-end": {
        flushStream()
        if (treeRef.current) {
          markWave(treeRef.current, e.n, "done")
          bumpTree()
        }
        return
      }
      case "done":
        flushStream()
        return
    }
  }

  async function run(prompt: string): Promise<void> {
    setBusy(true)
    runningToolsRef.current = 0
    setRunningTools(0)
    // spinner: 模型思考/无输出阶段给出可见的活动指示
    spinnerTimerRef.current = setInterval(() => setSpinner((s) => (s + 1) % 4), 120)
    // 新一轮任务树: 根 = 用户消息, 波次是它的分支
    const root: TaskNode = { id: `run_${Date.now()}`, label: prompt, status: "done", children: [] }
    treeRef.current = root
    setTree({ ...root })
    setTreePrompt(prompt)
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
      else if (result.steps > 1) appendLine({ kind: "tool-result", text: `✓ 完成: ${result.steps} 轮工具回环` })
    } catch (e) {
      appendLine({ kind: "error", text: e instanceof Error ? e.message : String(e) })
    }
    flushStream()
    // 清空未决的权限确认(中断/异常时不能让 Promise 悬空)
    for (const pending of askQueueRef.current) pending.resolve(false)
    askQueueRef.current = []
    setAsk(null)
    if (spinnerTimerRef.current) {
      clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
    // 纯问答(无工具调用)不残留空树占位
    if (treeRef.current && treeRef.current.children.length === 0) {
      treeRef.current = null
      setTree(null)
    }
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
      treeRef.current = null
      setTree(null)
      setTreePrompt("")
      return
    }
    if (trimmed === "/config") {
      openConfig()
      setInput("")
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
    if (settingsOpen) {
      if (key.escape) {
        setSettingsOpen(false)
        setInput("")
      } else if (key.tab || key.downArrow) {
        setConfigField((f) => (f + 1) % CONFIG_FIELDS.length)
      } else if (key.upArrow) {
        setConfigField((f) => (f + CONFIG_FIELDS.length - 1) % CONFIG_FIELDS.length)
      } else if (key.return) {
        saveConfigPanel()
      }
      return
    }
    if (key.ctrl && _input.toLowerCase() === "o") {
      openConfig()
      return
    }
    if (key.escape) {
      if (busy) controllerRef.current?.abort()
      else exit()
    }
  })

  useEffect(() => {
    appendLine({
      kind: "assistant",
      text: `MiniCode · 工作目录: ${cwd} · 模型: ${process.env.LLM_MODEL ?? "默认"} · Ctrl+o 设置 / 回车提交 / Esc 中断 / /quit 退出`,
    })
    return () => {
      if (spinnerTimerRef.current) clearInterval(spinnerTimerRef.current)
    }
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
      {tree && tree.children.length > 0 && (
        <Box marginTop={1}>
          <TaskTree run={{ id: 0, prompt: treePrompt, root: tree }} />
        </Box>
      )}
      {settingsOpen ? (
        <SettingsPanel
          draft={configDraft}
          field={configField}
          onChange={(key, value) => setConfigDraft((d) => ({ ...d, [key]: value }))}
        />
      ) : (
        <Box marginTop={1} flexDirection="row">
          <Text color="gray">
            {busy
              ? runningTools > 1
                ? `[${step}] ⚡并行×${runningTools}`
                : `[${step}] ${"⠋⠙⠹⠸"[spinner] ?? " "}`
              : ">"}{" "}
          </Text>
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
      )}
      <Box marginTop={1}>
        <Text color="gray">Ctrl+o 设置 · /config 设置 · /quit 退出 · /reset 清空</Text>
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