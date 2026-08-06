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
import { renderMarkdown } from "./markdown.tsx"
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
  /**
   * 打字机流式渲染: SSE delta 不断追加到 target, 定时器按单字推进 shown,
   * streamText = target.slice(0, shown)。感知是"逐字打出", 而不是分块涌入。
   * 渲染只更新一个短字符串, 不触碰 lines 数组。
   */
  const typeRef = useRef({ target: "", shown: 0 })
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const TYPE_INTERVAL_MS = 16
  const [streamText, setStreamText] = useState("")
  /** 流式速率诊断: 每秒收到字符数(区分网络慢 vs 渲染慢) */
  const [cps, setCps] = useState(0)
  const cpsRef = useRef({ chars: 0, last: performance.now() })
  /** 并行工具计数: 显示当前同时在跑的工具数, 让并发可视化 */
  const runningToolsRef = useRef(0)
  const [runningTools, setRunningTools] = useState(0)
  /** 当前运行的任务树(增量更新, 不重建) */
  const treeRef = useRef<TaskNode | null>(null)
  const [tree, setTree] = useState<TaskNode | null>(null)
  const [treePrompt, setTreePrompt] = useState("")
  /** VBuild 待确认的 RBuild 落盘 */
  const pendingVfsRef = useRef<import("../vfs.ts").VFS | null>(null)

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

  /** 打字机 tick: 每 16ms 推进一个字符(打字机手感); 积压超阈值时小幅加速保持跟手 */
  function typeTick(): void {
    typeTimerRef.current = null
    const st = typeRef.current
    if (st.shown >= st.target.length) return
    const pending = st.target.length - st.shown
    const step = pending > 400 ? 3 : pending > 200 ? 2 : 1
    st.shown = Math.min(st.target.length, st.shown + step)
    setStreamText(st.target.slice(0, st.shown))
    if (st.shown < st.target.length) {
      typeTimerRef.current = setTimeout(typeTick, TYPE_INTERVAL_MS)
    }
  }

  /** SSE delta 到达: 追加到打字机目标, 由 tick 逐字吐出 */
  function pushType(text: string): void {
    const st = typeRef.current
    st.target += text
    if (!typeTimerRef.current && st.shown < st.target.length) {
      typeTimerRef.current = setTimeout(typeTick, TYPE_INTERVAL_MS)
    }
  }

  /** 一轮完成/工具调用时, 把打字机已累积文本固化进对话流 */
  function commitStream(): void {
    if (typeTimerRef.current) {
      clearTimeout(typeTimerRef.current)
      typeTimerRef.current = null
    }
    const st = typeRef.current
    const full = st.target
    st.target = ""
    st.shown = 0
    setStreamText("")
    if (full) setLines((prev) => [...prev, { kind: "assistant", text: full }])
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
        commitStream()
        setStep(e.n)
        return
      case "text": {
        // 打字机: 追加到目标, 由 tick 逐字吐出(感知单字流动)
        pushType(e.text)
        // 速率统计: 1s 窗口内的字符数
        const now = performance.now()
        const c = cpsRef.current
        c.chars += e.text.length
        if (now - c.last >= 1000) {
          setCps(Math.round(c.chars / ((now - c.last) / 1000)))
          c.chars = 0
          c.last = now
        }
        return
      }
      case "wave-start": {
        commitStream()
        if (treeRef.current) {
          upsertWave(treeRef.current, e)
          bumpTree()
        }
        return
      }
      case "tool-start": {
        commitStream()
        runningToolsRef.current++
        setRunningTools(runningToolsRef.current)
        if (treeRef.current) {
          updateTool(treeRef.current, { id: e.id, tool: e.tool, status: "running" })
          bumpTree()
        }
        return
      }
      case "tool-result": {
        commitStream()
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
        commitStream()
        if (treeRef.current) {
          markWave(treeRef.current, e.n, "done")
          bumpTree()
        }
        return
      }
      case "done":
        commitStream()
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
    commitStream()
    const c = cpsRef.current
    c.chars = 0
    c.last = performance.now()
    setCps(0)
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

  /** /plan: 让 LLM 生成 DAG 计划, 交给 Influx 全并行执行(跨波次全并行) */
  async function runPlan(task: string): Promise<void> {
    setBusy(true)
    setInput("")
    appendLine({ kind: "user", text: `/plan ${task}` })
    appendLine({ kind: "tool-start", text: "计划生成中…(LLM 拆解 DAG)" })
    const controller = new AbortController()
    controllerRef.current = controller
    const { runPlannedTask, renderSpec } = await import("../influx/plan-runner.ts")
    const { VFS } = await import("../vfs.ts")
    // /plan 也走两段式: 写操作先进 overlay(VBuild), 确认后 RBuild 落盘
    const vfs = new VFS(cwd)

    const root: TaskNode = { id: `plan_${Date.now()}`, label: task, status: "done", children: [] }
    treeRef.current = root
    setTree({ ...root })
    setTreePrompt(`/plan ${task}`)
    // Runtime 事件无波次号, 用事件顺序推断: wave-start 开启新波次, node-start 属于当前波次
    let currentWave = 0

    try {
      const result = await runPlannedTask(task, {
        cwd,
        ask: queueAsk,
        vfs,
        onPlan: (spec) => {
          appendLine({ kind: "tool-result", text: `计划生成: ${renderSpec(spec).split("\n").length} 个节点` })
        },
        onEvent: (e) => {
          switch (e.type) {
            case "wave-start": {
              currentWave = e.n
              if (treeRef.current) {
                upsertWave(treeRef.current, { n: e.n, parallel: e.parallel, calls: [] })
                bumpTree()
              }
              break
            }
            case "node-start": {
              if (treeRef.current) {
                upsertWave(treeRef.current, { n: currentWave, parallel: true, calls: [] })
                const wave = treeRef.current.children.find((c) => c.id === `wave_${currentWave}`)
                if (wave && !wave.children.some((c) => c.id === e.key)) {
                  wave.children.push({ id: e.key, label: e.tool, status: "running", children: [] })
                }
                bumpTree()
              }
              break
            }
            case "node-end": {
              if (treeRef.current) {
                const wave = treeRef.current.children.find((c) => c.id === `wave_${currentWave}`)
                const node = wave?.children.find((c) => c.id === e.key)
                if (node) {
                  node.status = e.error ? "error" : "done"
                  node.ms = e.ms
                  if (e.error) node.error = e.error
                }
                if (wave && wave.children.length && wave.children.every((c) => c.status !== "running")) {
                  wave.status = "done"
                }
                bumpTree()
              }
              break
            }
            case "wave-end": {
              if (treeRef.current) {
                const wave = treeRef.current.children.find((c) => c.id === `wave_${currentWave}`)
                if (wave) wave.status = "done"
                bumpTree()
              }
              break
            }
          }
        },
      })
      appendLine({ kind: result.ok ? "tool-result" : "error", text: result.message })
      if (vfs.hasChanges()) {
        const s = vfs.summary()
        for (const c of vfs.diff()) {
          appendLine({
            kind: "tool-result",
            text: `  ${c.kind === "create" ? "+" : c.kind === "delete" ? "−" : "~"} ${c.path} (${c.bytes}B)`,
          })
        }
        pendingVfsRef.current = vfs
        appendLine({
          kind: "assistant",
          text: `RBuild 确认: 输入 y 落盘(${s.create + s.modify + s.del} 个文件并行写入), 输入 n 丢弃`,
        })
      }
    } catch (e) {
      appendLine({ kind: "error", text: e instanceof Error ? e.message : String(e) })
    }
    controllerRef.current = null
    setBusy(false)
    setStep(0)
    commitStream()
  }

  /**
   * /vbuild: 两段式构建。
   * VBuild —— 普通 agent 循环, 但 write/edit 只进 VFS overlay(内存, 可并行/可回滚),
   *           read 读到"构建中的世界"。全程零磁盘副作用。
   * 预览 diff → 用户确认 → RBuild 并行批量落盘。
   */
  async function runVBuild(task: string): Promise<void> {
    setBusy(true)
    setInput("")
    appendLine({ kind: "user", text: `/vbuild ${task}` })
    appendLine({ kind: "tool-start", text: "VBuild: 虚拟构建中…(写操作只进内存 overlay, 不落盘)" })
    const controller = new AbortController()
    controllerRef.current = controller
    const { VFS } = await import("../vfs.ts")

    const vfs = new VFS(cwd)
    const root: TaskNode = { id: `vbuild_${Date.now()}`, label: task, status: "done", children: [] }
    treeRef.current = root
    setTree({ ...root })
    setTreePrompt(`/vbuild ${task}`)

    try {
      const result = await runAgent({
        history: historyRef.current,
        userMessage: { role: "user", content: task },
        tools,
        system: buildSystemPrompt({ cwd, tools }),
        cwd,
        maxSteps: 30,
        signal: controller.signal,
        requests: (opts) => client.stream(opts),
        ask: queueAsk,
        onEvent: handleEvent,
        vfs,
      })
      historyRef.current = result.messages
      commitStream()
      if (!vfs.hasChanges()) {
        appendLine({ kind: "tool-result", text: "VBuild 完成: 无写操作(纯读/问答), 无需 RBuild" })
      } else {
        const s = vfs.summary()
        appendLine({
          kind: "tool-result",
          text: `VBuild 完成: 创建 ${s.create} / 修改 ${s.modify} / 删除 ${s.del}, 共 ${s.bytes} 字节`,
        })
        for (const c of vfs.diff()) {
          appendLine({
            kind: "tool-result",
            text: `  ${c.kind === "create" ? "+" : c.kind === "delete" ? "−" : "~"} ${c.path} (${c.bytes}B)`,
          })
        }
        pendingVfsRef.current = vfs
        appendLine({
          kind: "assistant",
          text: "RBuild 确认: 输入 y 落盘(并行写入), 输入 n 丢弃虚拟改动",
        })
      }
    } catch (e) {
      appendLine({ kind: "error", text: e instanceof Error ? e.message : String(e) })
    }
    controllerRef.current = null
    setBusy(false)
    setStep(0)
    commitStream()
  }

  function submit(value: string): void {
    const trimmed = value.trim()
    // VBuild 待确认: 输入 y/n 决定 RBuild 落盘或丢弃
    if (pendingVfsRef.current) {
      const vfs = pendingVfsRef.current
      pendingVfsRef.current = null
      if (trimmed.toLowerCase() === "y" || trimmed.toLowerCase() === "yes") {
        void (async () => {
          appendLine({ kind: "tool-start", text: "RBuild: 并行落盘…" })
          try {
            const changes = await vfs.commit()
            appendLine({ kind: "tool-result", text: `RBuild 完成: ${changes.length} 个文件已写入磁盘` })
          } catch (e) {
            appendLine({ kind: "error", text: `RBuild 失败: ${e instanceof Error ? e.message : String(e)}` })
          }
        })()
      } else {
        vfs.rollback()
        appendLine({ kind: "tool-result", text: "已丢弃虚拟改动(Rollback), 磁盘未动" })
      }
      setInput("")
      return
    }
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
    if (trimmed.startsWith("/plan")) {
      const task = trimmed.slice(5).trim()
      if (!task) {
        appendLine({ kind: "error", text: "用法: /plan <任务描述> — 让 LLM 生成计划并全并行执行" })
        return
      }
      void runPlan(task)
      return
    }
    if (trimmed.startsWith("/vbuild")) {
      const task = trimmed.slice(7).trim()
      if (!task) {
        appendLine({ kind: "error", text: "用法: /vbuild <任务描述> — 虚拟构建(VBuild), 确认后真实落盘(RBuild)" })
        return
      }
      void runVBuild(task)
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
      text: `MiniCode · ${cwd} · ${process.env.LLM_MODEL ?? "默认"} · Ctrl+o 设置 / /quit 退出`,
    })
    return () => {
      if (spinnerTimerRef.current) clearInterval(spinnerTimerRef.current)
    }
  }, [cwd])

  return (
    <Box flexDirection="column" width="100%">
      {/* 组合式布局: 上部 = 对话流 + 树侧边栏; 下部 = 输入行 */}
      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" alignItems="flex-start" flexGrow={1} width="50%">
          {lines.map((line, i) => {
            const prev = lines[i - 1]
            const isNewTurn = !prev || roleOf(prev.kind) !== roleOf(line.kind)
            const prefix = prefixFor(line.kind)
            return (
              <Box key={i} flexDirection="column" width="100%">
                {isNewTurn && prefix && <Text color="gray">─── {prefix.trim()} ───</Text>}
                {line.kind === "assistant" ? (
                  <Box flexDirection="column" width="100%">
                    {renderMarkdown(line.text)}
                  </Box>
                ) : (
                  <Text color={colorFor(line.kind)} wrap="wrap">
                    {line.text}
                  </Text>
                )}
              </Box>
            )
          })}
          {streamText && (
            <Box flexDirection="column" width="100%">
              {/* 打字机: 完整行走 markdown, 尾部未完成行当普通文本(避免半截代码块抖动) */}
              {renderMarkdown(streamText.slice(0, streamText.lastIndexOf("\n") + 1))}
              {streamText.slice(streamText.lastIndexOf("\n") + 1) && (
                <Text color="white">{streamText.slice(streamText.lastIndexOf("\n") + 1)}</Text>
              )}
            </Box>
          )}
        </Box>
        {tree && tree.children.length > 0 && (
          <Box marginLeft={2} width="50%" flexShrink={0}>
            <TaskTree run={{ id: 0, prompt: treePrompt, root: tree }} />
          </Box>
        )}
      </Box>
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
                : streamText
                  ? `[${step}] ${"⠋⠙⠹⠸"[spinner] ?? " "} ${cps}c/s`
                  : `[${step}] ${"⠋⠙⠹⠸"[spinner] ?? " "}`
              : ">"}{" "}
          </Text>
          {/* ask 时输入框保持可用: 提交走 submit() 的 ask 分支 */}
          <TextInput
            value={input}
            focus
            placeholder={
              ask
                ? `允许 ${ask.tool}? ${ask.summary} — 输入 y 放行 / 其他拒绝`
                : busy
                  ? "运行中…(Esc 中断)"
                  : "输入指令"
            }
            onChange={setInput}
            onSubmit={submit}
          />
        </Box>
      )}
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

/** 角色分组: 相同角色连续渲染时不分隔 */
function roleOf(kind: Line["kind"]): string {
  switch (kind) {
    case "user":
      return "user"
    case "assistant":
      return "assistant"
    case "tool-start":
    case "tool-result":
      return "tool"
    case "error":
      return "error"
  }
}

function prefixFor(kind: Line["kind"]): string {
  switch (kind) {
    case "user":
      return "你"
    case "assistant":
      return "MiniCode"
    case "tool-start":
      return "工具"
    case "tool-result":
      return "工具"
    case "error":
      return "错误"
  }
}