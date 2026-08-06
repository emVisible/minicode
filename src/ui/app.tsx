// Ink TUI 根组件 —— Apple 式信息架构(A1: 信息分三层, 永不混层)
//   内容层: 对话流(结构化 Msg[], 用户/助手/结论/警示/信息)
//   活动层: 右侧活动面板, 运行时展开, 完成后收回
//   系统层: 底部状态栏 + 诊断托盘(Ctrl+d, 默认折叠)
// 交互: Enter 提交, Tab 焦点轮回(输入框⇄活动面板), ↑↓/Enter/e 面板内导航,
//       Esc 中断当前轮(空闲时退出), Ctrl+d 诊断, /quit /reset /config /plan /vbuild

import React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import { basename, relative } from "node:path"
import { runAgent } from "../loop.ts"
import { buildSystemPrompt } from "../prompt.ts"
import { builtinTools } from "../tools.ts"
import { createLLMClient } from "../llm.ts"
import { saveConfig, applyConfigToEnv, configPath } from "../config.ts"
import { SettingsPanel } from "./settings.tsx"
import { useActivity, ActivityPanel } from "./activity.tsx"
import { Input } from "./input.tsx"
import { renderMarkdown } from "./markdown.tsx"
import { WelcomeCard } from "./welcome.tsx"
import { tokens, initialThemeName } from "./theme.ts"
import type { ThemeTokens, ThemeName } from "./theme.ts"
import type { MinicodeConfig } from "../config.ts"
import type { ChatMsg, DiagLine, LoopEvent, ToolDef } from "../types.ts"

interface AskState {
  tool: string
  summary: string
}

export default function App({ cwd, theme }: { cwd: string; theme?: ThemeName }): ReactNode {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const tools = useMemo<ToolDef[]>(() => builtinTools(), [])
  const client = useMemo(() => createLLMClient(), [])
  const system = useMemo(() => buildSystemPrompt({ cwd, tools }), [cwd, tools])

  // ---------- 主题 ----------
  const [themeName, setThemeName] = useState<ThemeName>(theme ?? initialThemeName())
  const t = useMemo<ThemeTokens>(() => tokens(themeName), [themeName])

  // ---------- 内容层: 结构化消息流 ----------
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState("")
  const [streamText, setStreamText] = useState("")
  const [cursorOn, setCursorOn] = useState(true)

  // ---------- 系统层: 状态 ----------
  const [busy, setBusy] = useState(false)
  const [spinner, setSpinner] = useState(0)
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [ask, setAsk] = useState<AskState | null>(null)
  /** Plan/Build 模式: Tab 切换。Plan 只生成计划不执行(仿 opencode/claude) */
  const [mode, setMode] = useState<"plan" | "build">("build")
  const askQueueRef = useRef<Array<{ req: AskState; resolve: (v: boolean) => void }>>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [configDraft, setConfigDraft] = useState<MinicodeConfig>({})
  const [configField, setConfigField] = useState(0)
  const historyRef = useRef<import("../types.ts").ChatMessage[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  const pendingVfsRef = useRef<import("../vfs.ts").VFS | null>(null)

  // ---------- 活动层 ----------
  const activity = useActivity()
  const activityOpen = activity.state.phase !== "idle" && activity.state.tree !== null
  const [actFocus, setActFocus] = useState(false)
  const [sel, setSel] = useState(-1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // ---------- 诊断托盘(Ctrl+d) ----------
  const [diag, setDiag] = useState<DiagLine[]>([])
  const [diagOpen, setDiagOpen] = useState(false)
  function pushDiag(level: DiagLine["level"], text: string): void {
    setDiag((prev) => [...prev, { ts: Date.now(), level, text }].slice(-50))
  }

  // ---------- 打字机流式渲染 ----------
  const typeRef = useRef({ target: "", shown: 0 })
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const TYPE_INTERVAL_MS = 16

  function typeTick(): void {
    typeTimerRef.current = null
    const st = typeRef.current
    if (st.shown >= st.target.length) return
    const pending = st.target.length - st.shown
    const step = pending > 400 ? 3 : pending > 200 ? 2 : 1
    st.shown = Math.min(st.target.length, st.shown + step)
    setStreamText(st.target.slice(0, st.shown))
    if (st.shown < st.target.length) typeTimerRef.current = setTimeout(typeTick, TYPE_INTERVAL_MS)
  }

  function pushType(text: string): void {
    const st = typeRef.current
    st.target += text
    if (!typeTimerRef.current && st.shown < st.target.length) {
      typeTimerRef.current = setTimeout(typeTick, TYPE_INTERVAL_MS)
    }
  }

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
    if (full.trim()) pushMsg({ kind: "assistant", text: full, ts: Date.now() })
  }

  function pushMsg(m: ChatMsg): void {
    setMsgs((prev) => [...prev, m])
  }

  /** 流式速率诊断(仅状态栏展示) */
  const cpsRef = useRef({ chars: 0, last: performance.now() })
  const [cps, setCps] = useState(0)

  /** 权限确认队列: 并行工具调用可能同时触发多个 ask, 逐个展示 */
  function queueAsk(req: AskState): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      askQueueRef.current.push({ req, resolve })
      if (!ask) setAsk(askQueueRef.current[0]!.req)
    })
  }

  function settleAsk(allow: boolean): void {
    askQueueRef.current.shift()?.resolve(allow)
    setAsk(askQueueRef.current[0]?.req ?? null)
  }

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
    pushMsg({ kind: "info", text: `✓ 设置已保存并生效 (${configPath()})`, ts: Date.now() })
  }

  const CONFIG_FIELDS: Array<{ key: keyof MinicodeConfig; label: string; placeholder: string; secret?: boolean }> = [
    { key: "llmUrl", label: "LLM URL", placeholder: "https://api.openai.com/v1" },
    { key: "llmApiKey", label: "API Key", placeholder: "sk-...", secret: true },
    { key: "llmModel", label: "Model", placeholder: "gpt-4o-mini" },
  ]

  /** 对话引擎事件 → 统一桥接活动层(不再写入对话流) */
  function handleEvent(e: LoopEvent): void {
    switch (e.type) {
      case "step":
        return
      case "text": {
        pushType(e.text)
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
      case "wave-start":
        commitStream()
        activity.waveStart(e.n, e.parallel, e.calls)
        return
      case "tool-start":
        commitStream()
        activity.nodeStart(e.id, e.tool)
        return
      case "tool-result":
        commitStream()
        if (e.error) pushDiag("warn", `${e.tool}: ${e.error.slice(0, 160)}`)
        activity.nodeResult(e.id, e.tool, e.ms, e.error)
        return
      case "wave-end":
        activity.waveEnd(e.n)
        return
      case "done":
        commitStream()
        return
    }
  }

  function vfsDiffLines(vfs: import("../vfs.ts").VFS): string[] {
    return vfs.diff().map((c) => `${c.kind === "create" ? "+" : c.kind === "delete" ? "−" : "~"} ${relPath(cwd, c.path)} (${c.bytes}B)`)
  }

  function setSpinnerTimer(): void {
    spinnerTimerRef.current = setInterval(() => setSpinner((s) => (s + 1) % 4), 120)
  }

  /** 拆解流式输出中的 "path":"..." 提取(预测式预取用) */
  function extractPrefetchPaths(text: string): string[] {    const out: string[] = []
    const re = /"path"\s*:\s*"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) out.push(m[1]!)
    return out
  }

  /** 预测式预取缓存: LLM 还在生成计划时, 就并行预读计划里要读的文件 */
  function createPrefetch(): import("../influx/core.ts").PrefetchCache {
    const cache = new Map<string, string>()
    return {
      get: (p) => cache.get(p),
      invalidate: (p) => {
        cache.delete(p)
      },
      warm: (paths) => {
        void (async () => {
          const { readFileSync, existsSync, statSync } = await import("node:fs")
          const { resolve } = await import("node:path")
          await Promise.all(
            paths.map(async (p) => {
              try {
                const abs = resolve(cwd, p)
                if (cache.has(abs) || !existsSync(abs)) return
                if (statSync(abs).size > 50 * 1024) return
                cache.set(abs, readFileSync(abs, "utf8"))
              } catch {
                // 路径不存在/无权限 → 忽略, 执行时自然读磁盘
              }
            }),
          )
        })()
      },
    }
  }

  async function runDual(prompt: string): Promise<void> {
    setBusy(true)
    setSpinnerTimer()
    const controller = new AbortController()
    controllerRef.current = controller
    const { VFS } = await import("../vfs.ts")
    const vfs = new VFS(cwd)
    const prefetch = createPrefetch()
    activity.begin(prompt)
    pushMsg({ kind: "user", text: prompt, ts: Date.now() })

    try {
      // ① 尝试拆解 DAG(1 次 LLM 调用, 低温度; 超时 90s + 失败自动重试一次)
      const { generatePlanSpec, countTaskNodes, runSpec, renderSpec, specHasParallelOps } = await import("../influx/plan-runner.ts")
      let spec: unknown
      let decomposeErr = ""
      const decomposeCtrl = new AbortController()
      const timer = setTimeout(() => decomposeCtrl.abort(), 90_000)
      try {
        spec = await generatePlanSpec(client, prompt, undefined, decomposeCtrl.signal, (text) => {
          activity.decompose(text)
          // 预测式预取: 计划还在生成时, 并行预读计划里声明的文件(IO 隐藏到 LLM 延迟后面)
          const paths = extractPrefetchPaths(text)
          if (paths.length) prefetch.warm(paths)
        })
      } catch (e) {
        decomposeErr = e instanceof Error ? e.message : String(e)
      } finally {
        clearTimeout(timer)
      }
      activity.setPhase("run")
      if (!spec) {
        pushDiag("warn", decomposeErr ? `拆解失败: ${decomposeErr}` : "拆解返回内容不是合法计划 JSON")
        pushMsg({ kind: "info", text: "拆解失败, 回退对话执行", ts: Date.now() })
      }
      const nodes = spec ? countTaskNodes(spec) : 0
      const hasFileOps = specHasParallelOps(spec)

      if (nodes >= 2 && hasFileOps) {
        // ② Influx 全并行执行
        pushMsg({
          kind: "info",
          text: `拆解完成 · ${nodes} 节点 · 全并行执行`,
          detail: renderSpec(spec).split("\n"),
          ts: Date.now(),
        })
        let curWave = 0
        const rep = await runSpec(spec, {
          cwd,
          ask: queueAsk,
          vfs,
          signal: controller.signal,
          task: prompt,
          prefetch,
          onEvent: (e) => {
            switch (e.type) {
              case "wave-start":
                curWave = e.n
                activity.waveStart(e.n, e.parallel)
                break
              case "node-start":
                activity.nodeStart(e.key, e.tool)
                break
              case "stream":
                activity.nodeStream(e.key, e.text)
                break
              case "node-end":
                if (e.error) pushDiag("warn", `节点 ${e.tool} 失败: ${e.error.slice(0, 160)}`)
                activity.nodeResult(e.key, e.tool, e.ms, e.error, e.summary)
                break
              case "wave-end":
                activity.waveEnd(curWave)
                break
            }
          },
        })
        if (rep.historyMessage) {
          historyRef.current = [...historyRef.current, { role: "user", content: prompt }, rep.historyMessage]
        }
        const hasChanges = vfs.hasChanges()
        if (rep.ok) {
          pushMsg({
            kind: "verdict",
            ok: true,
            text: `全并行 ${rep.waves} 波 · ${(rep.wallMs / 1000).toFixed(1)}s`,
            detail: hasChanges ? vfsDiffLines(vfs) : ["无文件修改(纯读/生成任务)"],
            ts: Date.now(),
          })
        } else {
          const fail = Object.keys(rep.errors).concat(Object.keys(rep.blocked))
          pushMsg({
            kind: "danger",
            text: `构建失败: ${fail.length} 个节点失败`,
            detail: fail.map((k) => `${k}: ${(rep.errors[k] ?? rep.blocked[k] ?? "").slice(0, 100)}`),
            ts: Date.now(),
          })
        }
        if (hasChanges) {
          pendingVfsRef.current = vfs
          pushMsg({ kind: "info", text: "Build 确认: 输入 y 完成落盘(RBuild) / 其他输入丢弃虚拟改动", ts: Date.now() })
        }
      } else {
        // ③ 回退: 普通对话(纯问答/拆解失败/拆解只有 llm 节点)
        if (spec && nodes >= 2 && !hasFileOps) pushMsg({ kind: "info", text: "拆解出纯分析任务, 走对话执行", ts: Date.now() })
        else if (spec) pushMsg({ kind: "info", text: "简单任务, 直接对话执行", ts: Date.now() })
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
        if (result.finish === "doom_loop") {
          pushDiag("err", "死循环保护: 同参数连续调用达到阈值后中止")
          pushMsg({ kind: "danger", text: "死循环保护: 已中止同参数重复调用", ts: Date.now() })
        } else if (result.finish === "aborted") {
          pushMsg({ kind: "danger", text: "已中断", ts: Date.now() })
        } else if (result.finish === "max_steps") {
          pushMsg({ kind: "danger", text: `已达 ${result.steps} 步上限, 未完成`, ts: Date.now() })
        } else if (result.steps > 1) {
          pushMsg({ kind: "verdict", ok: true, text: `完成 · ${result.steps} 轮工具回环`, ts: Date.now() })
        }
      }
    } catch (e) {
      pushMsg({ kind: "danger", text: e instanceof Error ? e.message : String(e), ts: Date.now() })
    }
    commitStream()
    const c = cpsRef.current
    c.chars = 0
    c.last = performance.now()
    setCps(0)
    for (const pending of askQueueRef.current) pending.resolve(false)
    askQueueRef.current = []
    setAsk(null)
    if (spinnerTimerRef.current) {
      clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
    activity.end()
    setActFocus(false)
    setSel(-1)
    controllerRef.current = null
    setBusy(false)
  }

  /**
   * Plan 模式: 只生成计划, 不执行。
   * 拆解(与 Build 同一 LLM 路径) → 计划骨架展示在活动面板 + 对话流, 然后停下。
   * 切到 Build 模式(Tab)后提交才真正执行 —— 先想清楚, 再动手。
   */
  async function runPlanOnly(prompt: string): Promise<void> {
    setBusy(true)
    setSpinnerTimer()
    const controller = new AbortController()
    controllerRef.current = controller
    activity.begin(prompt)
    pushMsg({ kind: "user", text: prompt, ts: Date.now() })
    try {
      const { generatePlanSpec, renderSpec } = await import("../influx/plan-runner.ts")
      let spec: unknown
      let decomposeErr = ""
      const decomposeCtrl = new AbortController()
      const timer = setTimeout(() => decomposeCtrl.abort(), 90_000)
      try {
        spec = await generatePlanSpec(client, prompt, undefined, decomposeCtrl.signal, (text) => {
          activity.decompose(text)
        })
      } catch (e) {
        decomposeErr = e instanceof Error ? e.message : String(e)
      } finally {
        clearTimeout(timer)
      }
      if (!spec) {
        pushDiag("warn", decomposeErr ? `拆解失败: ${decomposeErr}` : "拆解返回内容不是合法计划 JSON")
        pushMsg({ kind: "danger", text: "Plan 模式拆解失败, 未生成计划", ts: Date.now() })
        activity.setPhase("run")
      } else {
        const lines = renderSpec(spec).split("\n")
        activity.setPlan(lines)
        pushMsg({
          kind: "info",
          text: `计划已生成 · ${lines.length} 个节点(Plan 模式, 未执行)`,
          detail: lines,
          ts: Date.now(),
        })
        pushMsg({ kind: "info", text: "按 Tab 切到 Build 模式后重新提交, 才会执行此计划", ts: Date.now() })
        // 计划进入会话历史: Build 模式跟进提交时, 模型能看到此前的计划
        historyRef.current = [
          ...historyRef.current,
          { role: "user", content: prompt },
          { role: "assistant", content: `[计划模式] 已生成计划(未执行, 共 ${lines.length} 个节点):\n${renderSpec(spec)}` },
        ]
      }
    } catch (e) {
      pushMsg({ kind: "danger", text: e instanceof Error ? e.message : String(e), ts: Date.now() })
    }
    for (const pending of askQueueRef.current) pending.resolve(false)
    askQueueRef.current = []
    setAsk(null)
    if (spinnerTimerRef.current) {
      clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
    controllerRef.current = null
    setBusy(false)
  }

  async function runPlan(task: string): Promise<void> {
    setBusy(true)
    setSpinnerTimer()
    setInput("")
    pushMsg({ kind: "user", text: `/plan ${task}`, ts: Date.now() })
    const controller = new AbortController()
    controllerRef.current = controller
    const { runPlannedTask, renderSpec } = await import("../influx/plan-runner.ts")
    const { VFS } = await import("../vfs.ts")
    const vfs = new VFS(cwd)
    const prefetch = createPrefetch()
    activity.begin(task)

    try {
      const result = await runPlannedTask(task, {
        cwd,
        ask: queueAsk,
        vfs,
        signal: controller.signal,
        prefetch,
        onStream: (text) => {
          activity.decompose(text)
          // 预测式预取: 计划还在生成时, 并行预读计划里声明的文件
          const paths = extractPrefetchPaths(text)
          if (paths.length) prefetch.warm(paths)
        },
        onPlan: (spec) => {
          activity.setPhase("run")
          pushMsg({
            kind: "info",
            text: `计划生成 · ${renderSpec(spec).split("\n").length} 个节点`,
            detail: renderSpec(spec).split("\n"),
            ts: Date.now(),
          })
        },
        onEvent: (e) => {
          switch (e.type) {
            case "wave-start":
              activity.waveStart(e.n, e.parallel)
              break
            case "node-start":
              activity.nodeStart(e.key, e.tool)
              break
            case "stream":
              activity.nodeStream(e.key, e.text)
              break
            case "node-end":
              if (e.error) pushDiag("warn", `节点 ${e.tool} 失败: ${e.error.slice(0, 160)}`)
              activity.nodeResult(e.key, e.tool, e.ms, e.error, e.summary)
              break
            case "wave-end":
              activity.waveEnd(e.n)
              break
          }
        },
      })
      const hasChanges = vfs.hasChanges()
      if (result.ok) {
        pushMsg({
          kind: "verdict",
          ok: true,
          text: `计划完成 · ${result.waves} 波 · ${(result.wallMs / 1000).toFixed(1)}s`,
          detail: hasChanges ? vfsDiffLines(vfs) : ["无文件修改"],
          ts: Date.now(),
        })
      } else {
        const fail = Object.keys(result.errors).concat(Object.keys(result.blocked))
        pushMsg({
          kind: "danger",
          text: `计划失败: ${fail.length} 个节点失败`,
          detail: fail.map((k) => `${k}: ${(result.errors[k] ?? result.blocked[k] ?? "").slice(0, 100)}`),
          ts: Date.now(),
        })
      }
      if (hasChanges) {
        pendingVfsRef.current = vfs
        pushMsg({ kind: "info", text: "Build 确认: 输入 y 完成落盘(RBuild) / 其他输入丢弃虚拟改动", ts: Date.now() })
      }
      if (result.historyMessage) {
        historyRef.current = [...historyRef.current, { role: "user", content: `/plan ${task}` }, result.historyMessage]
      }
    } catch (e) {
      pushMsg({ kind: "danger", text: e instanceof Error ? e.message : String(e), ts: Date.now() })
    }
    commitStream()
    for (const pending of askQueueRef.current) pending.resolve(false)
    askQueueRef.current = []
    setAsk(null)
    if (spinnerTimerRef.current) {
      clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
    activity.end()
    setActFocus(false)
    setSel(-1)
    controllerRef.current = null
    setBusy(false)
      }

  async function runVBuild(task: string): Promise<void> {
    setBusy(true)
    setSpinnerTimer()
    setInput("")
    pushMsg({ kind: "user", text: `/vbuild ${task}`, ts: Date.now() })
    const controller = new AbortController()
    controllerRef.current = controller
    const { VFS } = await import("../vfs.ts")
    const vfs = new VFS(cwd)
    activity.begin(task)
    activity.setPhase("run")

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
        // Build 语义: VBuild 阶段写类(write/edit)只进虚拟层, 落盘要到 RBuild 确认,
        // 因此虚拟写不再逐次询问; bash 会真实执行命令, 仍需确认。
        ask: async (req) => {
          if (req.tool === "write" || req.tool === "edit") return true
          return queueAsk(req)
        },
        onEvent: handleEvent,
        vfs,
      })
      historyRef.current = result.messages
      commitStream()
      if (result.finish === "doom_loop") {
        pushDiag("err", "死循环保护: 同参数连续波次重复达到阈值后中止")
        pushMsg({ kind: "danger", text: "死循环保护: 已中止同参数重复调用", ts: Date.now() })
      } else if (result.finish === "aborted") {
        pushMsg({ kind: "danger", text: "Build 已中断", ts: Date.now() })
      } else if (result.finish === "max_steps") {
        pushMsg({ kind: "danger", text: `已达 ${result.steps} 步上限, 未完成`, ts: Date.now() })
      } else if (!vfs.hasChanges()) {
        pushMsg({ kind: "verdict", ok: true, text: "Build 完成 · 无写操作(纯读/问答)", ts: Date.now() })
      } else {
        const s = vfs.summary()
        pushMsg({
          kind: "verdict",
          ok: true,
          text: `VBuild 完成 · 创建 ${s.create} / 修改 ${s.modify} / 删除 ${s.del} · ${s.bytes} 字节`,
          detail: vfsDiffLines(vfs),
          ts: Date.now(),
        })
        pendingVfsRef.current = vfs
        pushMsg({
          kind: "info",
          text: `Build 确认: 输入 y 完成落盘(RBuild) / 其他输入丢弃虚拟改动`,
          ts: Date.now(),
        })
      }
    } catch (e) {
      pushMsg({ kind: "danger", text: e instanceof Error ? e.message : String(e), ts: Date.now() })
    }
    commitStream()
    for (const pending of askQueueRef.current) pending.resolve(false)
    askQueueRef.current = []
    setAsk(null)
    if (spinnerTimerRef.current) {
      clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
    activity.end()
    setActFocus(false)
    setSel(-1)
    controllerRef.current = null
    setBusy(false)
  }

  function submit(value: string): void {
    const trimmed = value.trim()
    // VBuild 待确认: 输入 y/n 决定 RBuild 落盘或丢弃
    if (pendingVfsRef.current) {
      const vfs = pendingVfsRef.current
      pendingVfsRef.current = null
      if (trimmed.toLowerCase() === "y" || trimmed.toLowerCase() === "yes") {
        void (async () => {
          pushMsg({ kind: "info", text: "RBuild: 落盘…", ts: Date.now() })
          try {
            const changes = await vfs.commit()
            pushMsg({ kind: "verdict", ok: true, text: `RBuild 完成 · ${changes.length} 个文件已写入磁盘`, ts: Date.now() })
          } catch (e) {
            pushMsg({ kind: "danger", text: `RBuild 失败: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() })
          }
        })()
      } else {
        vfs.rollback()
        pushMsg({ kind: "info", text: "已丢弃虚拟改动(Rollback), 磁盘未动", ts: Date.now() })
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
    if (busy) {
      pushMsg({ kind: "info", text: "上一轮仍在运行, 按 Esc 中断后再输入", ts: Date.now() })
      return
    }
    if (trimmed === "/quit" || trimmed === "/exit") {
      exit()
      return
    }
    if (trimmed === "/reset") {
      historyRef.current = []
      setMsgs([])
      activity.end()
      setDiag([])
      setInput("")
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
        pushMsg({ kind: "info", text: "用法: /plan <任务描述> — 让 LLM 生成计划并全并行执行", ts: Date.now() })
        return
      }
      void runPlan(task)
      return
    }
    if (trimmed.startsWith("/vbuild")) {
      if (mode === "plan") {
        pushMsg({ kind: "info", text: "Plan 模式下不执行构建, 按 Tab 切到 Build 模式", ts: Date.now() })
        return
      }
      const task = trimmed.slice(7).trim()
      if (!task) {
        pushMsg({ kind: "info", text: "用法: /vbuild <任务描述> — Build(两段式: 虚拟构建 VBuild → 确认落盘 RBuild)", ts: Date.now() })
        return
      }
      void runVBuild(task)
      return
    }
    setInput("")
    // Plan 模式: 只生成计划不执行; Build 模式: 完整执行
    if (mode === "plan") void runPlanOnly(trimmed)
    else void runDual(trimmed)
  }

  // 面板焦点导航: 扁平节点列表(选择序号)
  const flatNodes: Array<{ id: string }> = []
  if (activity.state.tree) {
    for (const w of activity.state.tree.children) {
      if (!w.id.startsWith("wave_")) continue
      for (const n of w.children) flatNodes.push({ id: n.id })
    }
  }

  useInput((input, key) => {
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
    // 活动面板焦点: ↑↓ 选择, Enter 展开/收起, e 全展开, Esc 返回输入框
    if (actFocus) {
      if (key.escape) {
        setActFocus(false)
        setSel(-1)
      } else if (key.upArrow) {
        setSel((s) => (flatNodes.length ? (s <= 0 ? flatNodes.length - 1 : s - 1) : -1))
      } else if (key.downArrow) {
        setSel((s) => (flatNodes.length ? (s + 1) % flatNodes.length : -1))
      } else if (key.return) {
        const node = flatNodes[sel]
        if (node) {
          setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(node.id)) next.delete(node.id)
            else next.add(node.id)
            return next
          })
        }
      } else if (input.toLowerCase() === "e") {
        setExpanded((prev) => (prev.size ? new Set() : new Set(flatNodes.map((n) => n.id))))
      }
      return true // 吞掉按键, 不让 TextInput 处理
    }
    if (key.tab) {
      if (busy) {
        // 运行中: Tab = 焦点切到活动面板
        setActFocus(true)
        setSel(flatNodes.length ? 0 : -1)
      } else if (mode === "plan") {
        // Plan 模式: Tab = 切回 Build(重新提交才执行)
        setMode("build")
        pushMsg({ kind: "info", text: "已切换到 Build 模式 · 提交任务将完整执行(VBuild → RBuild)", ts: Date.now() })
      } else {
        setMode("plan")
        pushMsg({ kind: "info", text: "已切换到 Plan 模式 · 提交任务只生成计划, 不执行", ts: Date.now() })
      }
      return true
    }
    if (key.ctrl && input.toLowerCase() === "o") {
      openConfig()
      return true
    }
    if (key.ctrl && input.toLowerCase() === "d") {
      setDiagOpen((v) => !v)
      return true
    }
    if (key.escape) {
      if (busy) controllerRef.current?.abort()
      else exit()
    }
  })

  // 打字机光标闪烁
  useEffect(() => {
    if (!streamText) {
      setCursorOn(true)
      return
    }
    const timer = setInterval(() => setCursorOn((v) => !v), 500)
    return () => clearInterval(timer)
  }, [streamText])

  useEffect(() => {
    return () => {
      if (spinnerTimerRef.current) clearInterval(spinnerTimerRef.current)
    }
  }, [])

  const modelName = process.env.LLM_MODEL ?? "默认"
  const cols = stdout.columns ?? 80
  const mdWidth = Math.max(36, Math.floor(cols * (activityOpen ? 0.58 : 1)) - 4)
  const spinnerChar = "⠋⠙⠹⠸"[spinner] ?? " "
  const phaseLabel =
    activity.state.phase === "decompose"
      ? "拆解中"
      : activity.state.phase === "run"
        ? activity.state.running > 0
          ? `执行中 ×${activity.state.running}`
          : "运行中"
        : ""

  return (
    <Box flexDirection="column" width="100%">
      <Header t={t} cwd={cwd} model={modelName} toolCount={tools.length} mode={mode} />
      {msgs.length === 0 && <WelcomeCard cwd={cwd} model={modelName} toolCount={tools.length} t={t} />}
      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" alignItems="flex-start" flexGrow={1}>
          {msgs.map((m, i) => (
            <MsgBlock key={i} msg={m} t={t} width={mdWidth} first={i === 0} />
          ))}
          {streamText && <StreamingBlock text={streamText} t={t} width={mdWidth} cursorOn={cursorOn} />}
        </Box>
        {activityOpen && (
          <Box
            marginLeft={2}
            width="40%"
            flexShrink={0}
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderColor={t.inkFaint}
            paddingLeft={1}
          >
            <ActivityPanel
              state={activity.state}
              t={t}
              focused={actFocus}
              sel={sel}
              expanded={expanded}
            />
          </Box>
        )}
      </Box>
      {diagOpen && <DiagTray lines={diag} t={t} />}
      {settingsOpen ? (
        <SettingsPanel
          draft={configDraft}
          field={configField}
          t={t}
          onChange={(key, value) => setConfigDraft((d) => ({ ...d, [key]: value }))}
        />
      ) : (
        <Box marginTop={1} flexDirection="row">
          <Text color={t.accent} bold>
            ❯{" "}
          </Text>
          <Input
            value={input}
            focus={!actFocus}
            t={t}
            placeholder={
              ask
                ? `允许 ${ask.tool}? ${ask.summary} — 输入 y 放行 / 其他拒绝`
                : busy
                  ? `运行中…(Esc 中断) ${spinnerChar}${phaseLabel}${cps ? ` · ${cps}c/s` : ""}`
                  : mode === "plan"
                    ? "Plan 模式 · 只生成计划不执行 (Tab 切换 Build)"
                    : "输入指令"
            }
            onChange={setInput}
            onSubmit={submit}
          />
          <Box flexGrow={1} />
          {actFocus && <Text color={t.accent}>↑↓ 选择 · Enter 展开 · e 全开 · Esc 返回</Text>}
        </Box>
      )}
    </Box>
  )
}

// ---------- 头部 ----------

function Header({ t, cwd, model, toolCount, mode }: { t: ThemeTokens; cwd: string; model: string; toolCount: number; mode: "plan" | "build" }): ReactNode {
  const dir = basename(cwd) || cwd
  return (
    <Box flexDirection="row" borderStyle="single" borderTop={false} borderBottom borderRight={false} borderLeft={false} borderColor={t.inkFaint} paddingBottom={1} marginBottom={1}>
      <Text color={t.accent} bold>
        ●{" "}
      </Text>
      <Text bold color={t.ink}>
        minicode
      </Text>
      <Text color={t.inkFaint}> {dir}</Text>
      <Box flexGrow={1} />
      <Text color={mode === "plan" ? t.accent : t.inkFaint} bold={mode === "plan"}>
        [{mode === "plan" ? "Plan" : "Build"}]{" "}
      </Text>
      <Text color={t.inkFaint}>
        {model} · {toolCount} 工具
      </Text>
    </Box>
  )
}

// ---------- 内容层消息块 ----------

function timeStr(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

const MsgBlock = React.memo(function MsgBlock({
  msg,
  t,
  width,
  first,
}: {
  msg: ChatMsg
  t: ThemeTokens
  width: number
  first: boolean
}): ReactNode {
  const mt = msg.kind === "user" || msg.kind === "assistant" ? 1 : 0
  switch (msg.kind) {
    case "user":
      return (
        <Box flexDirection="column" width="100%" marginTop={first ? 0 : 1}>
          <Box flexDirection="row">
            <Text color={t.inkDim} bold>
              你
            </Text>
            <Box flexGrow={1} />
            <Text color={t.inkFaint}>{timeStr(msg.ts)}</Text>
          </Box>
          <Text color={t.ink} wrap="wrap">
            {msg.text}
          </Text>
        </Box>
      )
    case "assistant":
      return (
        <Box
          flexDirection="column"
          width="100%"
          marginTop={first ? 0 : 1}
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={t.accentDim}
          paddingLeft={1}
        >
          {renderMarkdown(msg.text, t, width - 2)}
        </Box>
      )
    case "verdict":
      return (
        <Box flexDirection="column" width="100%" marginTop={1}>
          <Text wrap="wrap">
            <Text color={msg.ok ? t.ok : t.err} bold>
              {msg.ok ? "✓" : "✗"}{" "}
            </Text>
            <Text color={t.inkDim}>{msg.text}</Text>
          </Text>
          {msg.detail?.map((d, i) => (
            <Text key={i} color={t.inkFaint} wrap="wrap">
              {d}
            </Text>
          ))}
        </Box>
      )
    case "danger":
      return (
        <Box flexDirection="column" width="100%" marginTop={1}>
          <Text color={t.err} bold wrap="wrap">
            ✗ {msg.text}
          </Text>
          {msg.detail?.map((d, i) => (
            <Text key={i} color={t.err} dimColor wrap="wrap">
              {d}
            </Text>
          ))}
        </Box>
      )
    case "info":
      return (
        <Box flexDirection="column" width="100%" marginTop={mt === 0 ? 1 : 0}>
          <Text color={t.inkDim} wrap="wrap">
            {msg.text}
          </Text>
          {msg.detail?.map((d, i) => (
            <Text key={i} color={t.inkFaint} wrap="wrap">
              {d}
            </Text>
          ))}
        </Box>
      )
  }
})

function StreamingBlock({ text, t, width, cursorOn }: { text: string; t: ThemeTokens; width: number; cursorOn: boolean }): ReactNode {
  const cut = text.lastIndexOf("\n")
  const doneLines = text.slice(0, cut + 1)
  const tail = text.slice(cut + 1)
  return (
    <Box
      flexDirection="column"
      width="100%"
      marginTop={1}
      borderStyle="single"
      borderLeft
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={t.accentDim}
      paddingLeft={1}
    >
      {doneLines && renderMarkdown(doneLines, t, width - 2)}
      {tail && (
        <Text wrap="wrap">
          {tail}
          <Text color={cursorOn ? t.accentDim : t.inkFaint}>▍</Text>
        </Text>
      )}
    </Box>
  )
}

// ---------- 系统层: 诊断托盘 ----------

function DiagTray({ lines, t }: { lines: DiagLine[]; t: ThemeTokens }): ReactNode {
  return (
    <Box flexDirection="column" width="100%" marginTop={1} paddingX={1}>
      <Text color={t.inkFaint}>── 诊断 · Ctrl+d 收起 ──</Text>
      {lines.length === 0 && <Text color={t.inkFaint}>无诊断记录</Text>}
      {lines.map((l, i) => (
        <Text key={i} color={l.level === "err" ? t.err : l.level === "warn" ? t.warn : t.inkFaint} wrap="wrap">
          {timeStr(l.ts)} [{l.level}] {l.text}
        </Text>
      ))}
    </Box>
  )
}

/** 绝对路径 → 相对 cwd(对话流展示用, 保持简洁) */
function relPath(cwd: string, p: string): string {
  const rel = relative(cwd, p)
  return rel && !rel.startsWith("..") ? rel : p
}
