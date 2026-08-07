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
import { basename, join, relative } from "node:path"
import { runAgent } from "../loop.ts"
import { buildSystemPrompt } from "../prompt.ts"
import { builtinTools } from "../tools.ts"
import { createLLMClient } from "../llm.ts"
import { saveConfig, applyConfigToEnv, configPath } from "../config.ts"
import { log, logPath, logTail } from "../log.ts"
import { newFrame as undoNewFrame, undo as undoChanges, redo as redoChanges, undoStats } from "../undo.ts"
import { saveSession, listSessions, loadSession, newSessionId } from "../session.ts"
import { SettingsPanel } from "./settings.tsx"
import { useActivity, ActivityPanel, progressBar, NODE_GLYPH, computePanelLayout } from "./activity.tsx"
import { useMouse } from "./mouse.tsx"
import type { ActivityState } from "./activity.tsx"
import { Input } from "./input.tsx"
import { renderMarkdown } from "./markdown.tsx"
import { WelcomeCard } from "./welcome.tsx"
import { tokens, initialThemeName } from "./theme.ts"
import type { ThemeTokens, ThemeName } from "./theme.ts"
import type { MinicodeConfig } from "../config.ts"
import type { ChatMsg, DiagLine, LoopEvent, ToolDef } from "../types.ts"
import { useTerminalSize, estimateMsgHeight, estimateMarkdownHeight, computeWindow, totalHeight, clampOffset } from "./viewport.tsx"
import { COMMANDS, LEADER_KEYS, LEADER_TIMEOUT_MS, matchCommands, helpLines, transcriptName } from "../commands.ts"
import { notify } from "../notify.ts"
import { resolveRefs } from "../refs.ts"

interface AskState {
  tool: string
  summary: string
}

export default function App({ cwd, theme, resume }: { cwd: string; theme?: ThemeName; resume?: boolean }): ReactNode {
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
  /** 拆解开始时间戳(实时块显示等待时长) */
  const decomposeStartRef = useRef<number>(0)
  /** 当前会话 id(持久化用) */
  const sessionIdRef = useRef(newSessionId(cwd))
  /** 并发上限(/parallel 可调; 默认 min(8, CPU 核)) */
  const maxConcurrentRef = useRef<number>(0)
  /** /sessions 待选择的会话列表(输入序号加载) */
  const pendingSessionsRef = useRef<Array<{ id: string; label: string }> | null>(null)

  // --resume: 启动时恢复最近一次会话
  useEffect(() => {
    if (!resume) return
    void import("../session.ts").then(({ latestSession }) => {
      const rec = latestSession()
      if (rec && rec.msgs.length) {
        sessionIdRef.current = rec.id
        historyRef.current = rec.history
        setMsgs(rec.msgs)
        log.info("tui", "--resume 恢复会话", { id: rec.id, msgs: rec.msgs.length })
      }
    })
  }, [resume])

  // ---------- 活动层 ----------
  const activity = useActivity()
  const activityOpen = activity.state.phase !== "idle" && activity.state.tree !== null
  const [actFocus, setActFocus] = useState(false)
  const [sel, setSel] = useState(-1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // ---------- 视口滚动(把终端当网页) ----------
  // lockBottom: 贴底模式(对话钉底); 手动上滚解锁, 滚回底部重新上锁
  const [scrollOffset, setScrollOffset] = useState(0)
  const [scrollLock, setScrollLock] = useState(true)
  const scrollRef = useRef({ offset: 0, lock: true })
  scrollRef.current = { offset: scrollOffset, lock: scrollLock }
  /** 渲染期指标快照(useInput 回调经 ref 读取, 避免闭包过期/TDZ) */
  const metricsRef = useRef({ viewportRows: 20, heights: [] as number[], liveH: 0 })
  const scrollToBottom = (): void => {
    setScrollOffset(Number.MAX_SAFE_INTEGER)
    setScrollLock(true)
  }
  // ctrl+x 领衔快捷键: 按 ctrl+x 后 2s 内按第二键
  const leaderRef = useRef<{ target: string | null; timer: ReturnType<typeof setTimeout> | null }>({ target: null, timer: null })
  const [leaderHint, setLeaderHint] = useState<string | null>(null)

  // ---------- @ 文件补全(键入时实时候选, Tab 补全) ----------
  const atQuery = (() => {
    const m = input.match(/(?:^|\s)@([^\s@]+)$/)
    return m ? m[1] : null
  })()
  const [atCands, setAtCands] = useState<string[]>([])
  useEffect(() => {
    if (!atQuery) {
      setAtCands([])
      return
    }
    let alive = true
    void import("../refs.ts").then(({ matchAtCompletion }) =>
      matchAtCompletion(cwd, atQuery).then((r) => {
        if (alive) setAtCands(r)
      }),
    )
    return () => {
      alive = false
    }
  }, [atQuery, cwd])

  // ---------- 诊断托盘(Ctrl+d) ----------
  const [diag, setDiag] = useState<DiagLine[]>([])
  const [diagOpen, setDiagOpen] = useState(false)
  function pushDiag(level: DiagLine["level"], text: string): void {
    setDiag((prev) => [...prev, { ts: Date.now(), level, text }].slice(-50))
  }

  // ---------- 打字机流式渲染 ----------
  const typeRef = useRef({ target: "", shown: 0 })
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 打字机速率: 12ms/tick, 积压越大步进越大 —— 长输出不再拖慢观感(主观速度)
  const TYPE_INTERVAL_MS = 12

  function typeTick(): void {
    typeTimerRef.current = null
    const st = typeRef.current
    if (st.shown >= st.target.length) return
    const pending = st.target.length - st.shown
    const step = pending > 600 ? 8 : pending > 250 ? 4 : 2
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

  /** 会话持久化: msgs 变化后防抖落盘(退出/恢复可续) */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveSession({
        id: sessionIdRef.current,
        cwd,
        model: process.env.LLM_MODEL ?? "默认",
        mode,
        createdAt: Date.now(),
        msgs,
        history: historyRef.current,
      })
    }, 800)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [msgs, mode])

  /** 流式速率诊断(仅状态栏展示) */
  const cpsRef = useRef({ chars: 0, last: performance.now() })
  const [cps, setCps] = useState(0)

  /** 权限确认队列: 并行工具调用可能同时触发多个 ask, 逐个展示 */
  function queueAsk(req: AskState): Promise<boolean> {
    notify("权限询问", `${req.tool}: ${req.summary.slice(0, 80)}`)
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

  /**
   * 统一构建入口(声明 → 执行 两阶段)。
   * 声明阶段: 拆解出执行声明(spec, 每节点带 desc 意图注释), 呈现给用户;
   * 执行阶段: 严格按声明跑 DAG(节点与依赖已锁定, 实现不跑偏)。
   * display: 对话流展示的用户消息文本(纯任务 vs /vbuild 前缀)。
   */
  async function runBuild(prompt: string, display: string): Promise<void> {
    undoNewFrame()
    setBusy(true)
    setSpinnerTimer()
    const controller = new AbortController()
    controllerRef.current = controller
    const { VFS } = await import("../vfs.ts")
    const vfs = new VFS(cwd)
    const prefetch = createPrefetch()
    decomposeStartRef.current = Date.now()
    activity.begin(prompt)
    pushMsg({ kind: "user", text: display, ts: Date.now() })
    log.info("tui", "Build 执行开始", { prompt: prompt.slice(0, 120) })

    try {
      // ① 尝试拆解 DAG(1 次 LLM 调用, 低温度; 超时 90s + 失败自动重试一次)
      const { generatePlanSpec, countTaskNodes, runSpec, renderSpec, specHasParallelOps } = await import("../influx/plan-runner.ts")
      let spec: unknown
      let decomposeErr = ""
      const decomposeCtrl = new AbortController()
      const timer = setTimeout(() => decomposeCtrl.abort(), 90_000)
      // 声明骨架逐 key 推流: 流式文本里每出现一个 "key":"k1", 就推一行 ▸ k1,
      // 模型不出流时也能让用户看到"声明在推进"(不再是纯秒表)
      const seenDecomposeKeys = new Set<string>()
      try {
        spec = await generatePlanSpec(client, prompt, undefined, decomposeCtrl.signal, (text) => {
          activity.decompose(text)
          // 预测式预取: 计划还在生成时, 并行预读计划里声明的文件(IO 隐藏到 LLM 延迟后面)
          const paths = extractPrefetchPaths(text)
          if (paths.length) prefetch.warm(paths)
          // 骨架推流: "key":"k1" → ▸ k1(去重, 每 key 一行)
          for (const m of text.matchAll(/"key"\s*:\s*"([a-zA-Z0-9_-]+)"/g)) {
            const k = m[1]!
            if (!seenDecomposeKeys.has(k)) {
              seenDecomposeKeys.add(k)
              activity.decompose(`\n▸ 节点 ${k}`)
            }
          }
        }, cwd)
      } catch (e) {
        decomposeErr = e instanceof Error ? e.message : String(e)
      } finally {
        clearTimeout(timer)
      }
      activity.setPhase("run")
      if (!spec) {
        const reason = decomposeErr || "(返回内容不是合法计划 JSON)"
        log.warn("tui", "拆解失败, 回退对话", { error: reason.slice(0, 500) })
        pushDiag("warn", `拆解失败: ${reason}`)
        pushMsg({ kind: "info", text: `拆解失败, 回退对话执行: ${reason.slice(0, 140)}`, ts: Date.now() })
      }
      const nodes = spec ? countTaskNodes(spec) : 0
      const hasFileOps = specHasParallelOps(spec)

      if (nodes >= 2 && hasFileOps) {
        // ② 执行阶段: 严格按声明跑 DAG
        const decomposeMs = decomposeStartRef.current ? ((Date.now() - decomposeStartRef.current) / 1000).toFixed(1) : "?"
        log.info("tui", "走声明执行", { nodes, decomposeMs })
        pushMsg({
          kind: "info",
          text: `声明 · ${nodes} 节点 · ${decomposeMs}s`,
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
          maxConcurrent: maxConcurrentRef.current || undefined,
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
              case "node-end": {
                if (e.error) pushDiag("warn", `节点 ${e.tool} 失败: ${e.error.slice(0, 160)}`)
                activity.nodeResult(e.key, e.tool, e.ms, e.error, e.summary)
                // llm 节点输出持久进对话流: 模型不流式时内容一次性到达, feed 会随完成消失,
                // 必须落一条对话消息, 用户才能看到生成的内容(修改代码的逻辑过程)
                if (!e.error && (e.tool === "llm" || e.tool === "agent.llm")) {
                  const content = activity.state.streams.get(e.key) ?? ""
                  if (content.trim()) {
                    pushMsg({
                      kind: "info",
                      text: `⚡ ${e.key} [${e.tool}] 输出 · ${(e.ms / 1000).toFixed(1)}s`,
                      detail: [content.slice(0, 1500) + (content.length > 1500 ? "…" : "")],
                      ts: Date.now(),
                    })
                  }
                }
                break
              }
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
        log.info("tui", "构建结束", { ok: rep.ok, waves: rep.waves, wallMs: rep.wallMs.toFixed(0), errors: Object.keys(rep.errors), blocked: Object.keys(rep.blocked) })
        if (rep.ok) {
          pushMsg({
            kind: "verdict",
            ok: true,
            text: `${rep.waves} 波 · ${(rep.wallMs / 1000).toFixed(1)}s`,
            detail: hasChanges ? vfsDiffLines(vfs) : ["无文件修改(纯读/生成任务)"],
            ts: Date.now(),
          })
        } else {
          const fail = Object.keys(rep.errors).concat(Object.keys(rep.blocked))
          pushMsg({
            kind: "danger",
            text: `构建失败: ${fail.length} 个节点失败`,
            detail: fail.map((k) => `${k}: ${(rep.errors[k] ?? rep.blocked[k] ?? "").slice(0, 240)}`),
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
        // 执行模式 framing: 长系统提示词(axiom)常让模型"内化原则"后停下来反问,
        // 必须显式声明"user 消息就是任务, 直接动手", 阻止模型只读/询问不产出。
        const execSystem = `${system}\n\n[执行模式]\n- 你收到的 user 消息就是用户下达的任务, 不是闲聊开场。\n- 直接动手: 先 read 看代码 → write 修改 → bash 验证。\n- 不要问"需要我做什么", 不要复述或评价系统提示词, 不要只做探索。\n- 任务描述宽泛时, 基于代码现状做最合理的改进并完成它。`
        const result = await runAgent({
          history: historyRef.current,
          userMessage: { role: "user", content: prompt },
          tools,
          system: execSystem,
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
        } else if (result.writes === 0 && result.steps >= 5) {
          // 多轮执行却没有任何写调用 → 任务没被真正执行, 如实报告而不是假装"完成"
          pushMsg({
            kind: "danger",
            text: `未修改任何文件 · ${result.steps} 轮只读/询问`,
            detail: ["模型多轮没有调用 write/edit。可重试, 或换更明确的任务描述(拆解失败可能与此有关)。"],
            ts: Date.now(),
          })
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
    notify("构建结束", `· ${prompt.slice(0, 40)}`)
    activity.end()
    setActFocus(false)
    setSel(-1)
    controllerRef.current = null
    setBusy(false)
  }

  /** 默认入口(对话提交)与 /vbuild 共用 runBuild —— 声明 → 执行, 同一实现 */
  function runDual(prompt: string): Promise<void> {
    return runBuild(prompt, prompt)
  }

  function runVBuild(task: string): Promise<void> {
    setInput("")
    return runBuild(task, `/vbuild ${task}`)
  }

  /**
   * Plan 模式: 只生成计划, 不执行。
   * 拆解(与 Build 同一 LLM 路径) → 计划骨架展示在活动面板 + 对话流, 然后停下。
   * 切到 Build 模式(Tab)后提交才真正执行 —— 先想清楚, 再动手。
   */
  async function runPlanOnly(prompt: string): Promise<void> {
    undoNewFrame()
    setBusy(true)
    setSpinnerTimer()
    const controller = new AbortController()
    controllerRef.current = controller
    decomposeStartRef.current = Date.now()
    activity.begin(prompt)
    pushMsg({ kind: "user", text: prompt, ts: Date.now() })
    log.info("tui", "Plan 模式: 只生成计划", { prompt: prompt.slice(0, 120) })
    try {
      const { generatePlanSpec, renderSpec } = await import("../influx/plan-runner.ts")
      let spec: unknown
      let decomposeErr = ""
      const decomposeCtrl = new AbortController()
      const timer = setTimeout(() => decomposeCtrl.abort(), 90_000)
      try {
        spec = await generatePlanSpec(client, prompt, undefined, decomposeCtrl.signal, (text) => {
          activity.decompose(text)
        }, cwd)
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
        log.info("tui", "计划已生成(未执行)", { nodes: lines.length })
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
    notify("计划结束", `· ${prompt.slice(0, 40)}`)
  }

  async function runPlan(task: string): Promise<void> {
    undoNewFrame()
    setBusy(true)
    setSpinnerTimer()
    setInput("")
    pushMsg({ kind: "user", text: `/plan ${task}`, ts: Date.now() })
    log.info("tui", "/plan 开始", { task: task.slice(0, 120) })
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
            case "node-end": {
              if (e.error) pushDiag("warn", `节点 ${e.tool} 失败: ${e.error.slice(0, 160)}`)
              activity.nodeResult(e.key, e.tool, e.ms, e.error, e.summary)
              if (!e.error && (e.tool === "llm" || e.tool === "agent.llm")) {
                const content = activity.state.streams.get(e.key) ?? ""
                if (content.trim()) {
                  pushMsg({
                    kind: "info",
                    text: `⚡ ${e.key} [${e.tool}] 输出 · ${(e.ms / 1000).toFixed(1)}s`,
                    detail: [content.slice(0, 1500) + (content.length > 1500 ? "…" : "")],
                    ts: Date.now(),
                  })
                }
              }
              break
            }
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
          detail: fail.map((k) => `${k}: ${(result.errors[k] ?? result.blocked[k] ?? "").slice(0, 240)}`),
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
    notify("计划执行结束", `· ${task.slice(0, 40)}`)
      }

  /**
   * /init: 分析项目并生成 AGENTS.md(对齐 opencode /init)。
   * 走对话引擎(只读探索 + write 生成), 写入前需用户确认。
   */
  async function runInit(): Promise<void> {
    undoNewFrame()
    setBusy(true)
    setSpinnerTimer()
    setInput("")
    pushMsg({ kind: "user", text: `/init`, ts: Date.now() })
    log.info("tui", "/init 生成 AGENTS.md")
    const controller = new AbortController()
    controllerRef.current = controller
    const initSystem = [
      buildSystemPrompt({ cwd, tools }),
      "",
      "当前任务: 为该项目生成 AGENTS.md(项目协作规则文件, 供后续所有 session 注入)。",
      "要求:",
      "- 用 read/glob/grep 先探索项目结构(包管理、入口、测试、构建命令、代码风格约定)",
      "- 内容: 项目简介 / 常用命令(dev/test/build/typecheck) / 目录结构要点 / 编码约定 / 测试与验证方式",
      "- 简洁, 5-30 行, 用中文",
      "- 最终用 write 工具把内容写入项目根目录 AGENTS.md(覆盖已有文件前说明变更)",
    ].join("\n")
    try {
      const result = await runAgent({
        history: [],
        userMessage: { role: "user", content: "分析本项目并生成 AGENTS.md" },
        tools,
        system: initSystem,
        cwd,
        maxSteps: 20,
        signal: controller.signal,
        requests: (opts) => client.stream(opts),
        ask: queueAsk,
        onEvent: handleEvent,
      })
      commitStream()
      historyRef.current = [...historyRef.current, { role: "user", content: "/init" }, ...result.messages]
      if (result.finish === "doom_loop") pushMsg({ kind: "danger", text: "死循环保护: 已中止", ts: Date.now() })
      else if (result.finish === "aborted") pushMsg({ kind: "danger", text: "已中断", ts: Date.now() })
      else if (result.finish === "max_steps") pushMsg({ kind: "danger", text: `已达 ${result.steps} 步上限, 未完成`, ts: Date.now() })
      else pushMsg({ kind: "verdict", ok: true, text: "/init 完成 · AGENTS.md 已写入(后续 session 自动注入)", ts: Date.now() })
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
            log.info("tui", "RBuild 落盘完成", { files: changes.length })
            pushMsg({ kind: "verdict", ok: true, text: `RBuild 完成 · ${changes.length} 个文件已写入磁盘`, ts: Date.now() })
          } catch (e) {
            pushMsg({ kind: "danger", text: `RBuild 失败: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() })
          }
        })()
      } else {
        vfs.rollback()
        log.info("tui", "RBuild 丢弃(rollback)", {})
        pushMsg({ kind: "info", text: "已丢弃虚拟改动(Rollback), 磁盘未动", ts: Date.now() })
      }
      setInput("")
      return
    }
    // /sessions 列表恢复: 输入序号加载对应会话
    if (pendingSessionsRef.current) {
      const list = pendingSessionsRef.current
      pendingSessionsRef.current = null
      const n = parseInt(trimmed, 10)
      const target = list[n - 1]
      if (target) {
        const rec = loadSession(target.id)
        if (rec) {
          sessionIdRef.current = rec.id
          historyRef.current = rec.history
          setMsgs(rec.msgs)
          pushMsg({ kind: "info", text: `已恢复会话: ${target.label}`, ts: Date.now() })
        } else {
          pushMsg({ kind: "info", text: "会话加载失败", ts: Date.now() })
        }
      } else {
        pushMsg({ kind: "info", text: "无效序号", ts: Date.now() })
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
    if (trimmed === "/parallel" || trimmed.startsWith("/parallel ")) {
      const n = Number(trimmed.replace("/parallel", "").trim())
      if (!Number.isInteger(n) || n < 1) {
        pushMsg({ kind: "info", text: "用法: /parallel <N>, N ≥ 1 整数; 默认 min(8, CPU 核数)", ts: Date.now() })
      } else {
        maxConcurrentRef.current = n
        pushMsg({ kind: "info", text: `并发上限 = ${n}(同时执行节点数)`, ts: Date.now() })
      }
      setInput("")
      return
    }
    if (trimmed === "/log") {
      pushMsg({
        kind: "info",
        text: `日志文件: ${logPath()}`,
        detail: logTail(40),
        ts: Date.now(),
      })
      setInput("")
      return
    }
    if (trimmed === "/undo") {
      const r = undoChanges()
      pushMsg({ kind: "info", text: r.msg, detail: r.restored.map((p) => `恢复 ${relPath(cwd, p)}`), ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/redo") {
      const r = redoChanges()
      pushMsg({ kind: "info", text: r.msg, detail: r.restored.map((p) => `重做 ${relPath(cwd, p)}`), ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/sessions") {
      const list = listSessions()
      if (!list.length) {
        pushMsg({ kind: "info", text: "暂无已保存的会话", ts: Date.now() })
        return
      }
      const detail = list.map((s, i) => `${i + 1}. ${s.firstMsg}  (${s.msgs} 条消息, ${new Date(s.createdAt).toLocaleString()})`)
      pendingSessionsRef.current = list.map((s, i) => ({ id: s.id, label: s.firstMsg }))
      pushMsg({ kind: "info", text: `会话列表(输入序号恢复, 如 1):`, detail, ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/init") {
      void runInit()
      setInput("")
      return
    }
    if (trimmed === "/reset" || trimmed === "/new" || trimmed === "/clear") {
      historyRef.current = []
      setMsgs([])
      activity.end()
      setDiag([])
      sessionIdRef.current = newSessionId(cwd)
      scrollToBottom()
      setInput("")
      return
    }
    if (trimmed === "/help") {
      pushMsg({
        kind: "info",
        text: "命令列表(ctrl+x + 字母为快捷键 · Tab 补全 / 命令):",
        detail: helpLines(),
        ts: Date.now(),
      })
      setInput("")
      return
    }
    if (trimmed === "/models") {
      pushMsg({
        kind: "info",
        text: "当前模型:",
        detail: [`LLM_MODEL = ${process.env.LLM_MODEL ?? "(未设置)"}`, `LLM_URL = ${process.env.LLM_URL ?? process.env.API_URL ?? "(未设置)"}`, "换模型: /config 修改后保存即生效"],
        ts: Date.now(),
      })
      setInput("")
      return
    }
    if (trimmed === "/themes") {
      setThemeName((prev) => (prev === "dark" ? "light" : "dark"))
      setInput("")
      return
    }
    if (trimmed === "/export") {
      void exportTranscript()
      setInput("")
      return
    }
    if (trimmed === "/compact") {
      void compactHistory()
      setInput("")
      return
    }
    if (trimmed === "/config" || trimmed === "/connect") {
      openConfig()
      setInput("")
      return
    }
    if (trimmed === "/details") {
      const allOpen = flatNodes.length > 0 && expanded.size === flatNodes.length
      setExpanded(allOpen ? new Set() : new Set(flatNodes.map((n) => n.id)))
      pushMsg({ kind: "info", text: allOpen ? "已收起全部节点详情" : `已展开全部节点详情(${flatNodes.length})`, ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/editor") {
      void composeInEditor()
      setInput("")
      return
    }
    if (trimmed.startsWith("/plan")) {
      const task = trimmed.slice(5).trim()
      if (!task) {
        pushMsg({ kind: "info", text: "用法: /plan <任务描述> — 拆解为 DAG 并并行执行", ts: Date.now() })
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
        pushMsg({ kind: "info", text: "用法: /vbuild <任务描述> — 声明 → 执行: 先生成执行声明, 再按声明构建", ts: Date.now() })
        return
      }
      void runVBuild(task)
      return
    }
    setInput("")
    // !命令: 直接执行 shell, 不走 LLM(对齐 opencode !command)
    if (trimmed.startsWith("!")) {
      void runShell(trimmed.slice(1).trim())
      return
    }
    // @引用: 解析文件引用后, 把真实文本交给引擎
    void (async () => {
      const { text, refs } = await resolveRefs(cwd, trimmed)
      if (refs.length) {
        pushMsg({
          kind: "info",
          text: `已引用 ${refs.length} 个文件:`,
          detail: refs.map((r) => relative(cwd, r.path)),
          ts: Date.now(),
        })
        log.info("tui", "@引用文件", { refs: refs.map((r) => r.path) })
      }
      // Plan 模式: 只生成计划不执行; Build 模式: 完整执行
      if (mode === "plan") void runPlanOnly(refs.length ? `${text}\n\n[已引用文件内容]\n${refs.map((r) => `# ${relative(cwd, r.path)}\n${r.content}`).join("\n\n")}` : text)
      else void runDual(refs.length ? `${text}\n\n[已引用文件内容]\n${refs.map((r) => `# ${relative(cwd, r.path)}\n${r.content}`).join("\n\n")}` : text)
    })()
  }

  /** !cmd: 直接执行 shell 命令, 输出进对话(不走 LLM) */
  async function runShell(cmd: string): Promise<void> {
    if (!cmd) {
      pushMsg({ kind: "info", text: "用法: ! <命令> — 直接执行 shell, 输出进对话", ts: Date.now() })
      return
    }
    pushMsg({ kind: "user", text: `! ${cmd}`, ts: Date.now() })
    log.info("tui", "!shell 直跑", { cmd: cmd.slice(0, 160) })
    const { exec } = await import("node:child_process")
    const { promisify } = await import("node:util")
    try {
      const { stdout: so, stderr: se } = await promisify(exec)(cmd, { cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
      const out = `${so}${se}`.trim()
      pushMsg({
        kind: "verdict",
        ok: true,
        text: `shell 完成 · ${cmd.slice(0, 60)}`,
        detail: (out ? out.split("\n") : ["(无输出)"]).slice(0, 60),
        ts: Date.now(),
      })
    } catch (e) {
      const err = e as { code?: number | string; message?: string; stdout?: string; stderr?: string }
      pushMsg({
        kind: "danger",
        text: `shell 失败(exit ${err.code ?? "?"}): ${cmd.slice(0, 80)}`,
        detail: String(err.stderr ?? err.stdout ?? err.message ?? e).split("\n").slice(0, 40),
        ts: Date.now(),
      })
    }
  }

  /** /export: 会话导出为 Markdown(对齐 opencode /export) */
  async function exportTranscript(): Promise<void> {
    const { writeFileSync } = await import("node:fs")
    const name = transcriptName()
    const path = join(cwd, name)
    const esc = (s: string): string => s.replace(/\r/g, "")
    const lines = [
      `# MiniCode Transcript · ${new Date().toLocaleString()}`,
      `\n## 目录: ${cwd}\n`,
      ...msgs.map((m) => {
        const head =
          m.kind === "user" ? "## 你" : m.kind === "assistant" ? "## 助手" : m.kind === "verdict" ? `## 结论 ${m.ok ? "✓" : "✗"}` : m.kind === "danger" ? "## 错误" : "## 信息"
        const detail = m.kind === "user" || m.kind === "assistant" ? [] : m.detail ?? []
        const body = [m.text, ...detail].map(esc).join("\n")
        return `${head} (${timeStr(m.ts)})\n\n${body}\n`
      }),
    ]
    try {
      writeFileSync(path, lines.join("\n"), "utf8")
      pushMsg({ kind: "verdict", ok: true, text: `已导出: ${name}`, detail: [path], ts: Date.now() })
      log.info("tui", "/export 完成", { path })
    } catch (e) {
      pushMsg({ kind: "danger", text: `导出失败: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() })
    }
  }

  /**
   * /editor: 用外部编辑器撰写消息(对齐 opencode /editor)。
   * 以 GUI 编辑器为主($EDITOR 如 code --wait): 后台拉起, 轮询文件内容变化,
   * 内容稳定后读入输入框 —— 不抢占终端(raw mode 下无法前台跑 vim 类编辑器)。
   */
  async function composeInEditor(): Promise<void> {
    const editor = process.env.EDITOR
    if (!editor) {
      pushMsg({ kind: "info", text: "未设置 EDITOR 环境变量(如 export EDITOR=\"code --wait\")", ts: Date.now() })
      return
    }
    const { tmpdir } = await import("node:os")
    const { writeFileSync, readFileSync } = await import("node:fs")
    const { spawn } = await import("node:child_process")
    const { join } = await import("node:path")
    const file = join(tmpdir(), `minicode-compose-${Date.now()}.md`)
    writeFileSync(file, "", "utf8")
    const [cmd, ...args] = editor.split(/\s+/)
    try {
      const child = spawn(cmd!, [...args, file], { detached: true, stdio: "ignore" })
      child.unref()
    } catch (e) {
      pushMsg({ kind: "danger", text: `无法启动编辑器 ${editor}: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() })
      return
    }
    pushMsg({ kind: "info", text: `已打开编辑器(${editor}), 保存内容后自动读入输入框`, ts: Date.now() })
    let prev = ""
    let stableSince = 0
    const timer = setInterval(() => {
      try {
        const cur = readFileSync(file, "utf8")
        if (cur !== prev) {
          prev = cur
          stableSince = Date.now()
        } else if (cur.trim() && stableSince && Date.now() - stableSince > 1500) {
          clearInterval(timer)
          setInput(cur.trimEnd())
          pushMsg({ kind: "info", text: `已读入编辑器内容(${cur.length} 字符), 按 Enter 提交`, ts: Date.now() })
        }
      } catch {
        // 文件暂不可读, 继续轮询
      }
    }, 800)
    setTimeout(() => clearInterval(timer), 24 * 3600 * 1000)
  }

  /** /compact: 长会话压缩为摘要, 截断上下文(对齐 opencode /compact) */
  async function compactHistory(): Promise<void> {
    const hist = historyRef.current
    if (hist.length < 6) {
      pushMsg({ kind: "info", text: `上下文尚短(${hist.length} 条), 无需压缩`, ts: Date.now() })
      return
    }
    pushMsg({ kind: "info", text: "正在压缩上下文…", ts: Date.now() })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const digest = hist
        .map((m) => `[${m.role}] ${m.content.slice(0, 400)}`)
        .join("\n")
        .slice(0, 24_000)
      let summary = ""
      const res = await client.stream({
        messages: [
          { role: "system", content: "你是会话压缩器。把对话压缩成一段 ≤300 字的项目上下文摘要(目标/关键发现/已做改动/未决问题), 供后续会话使用。只输出摘要本身。" },
          { role: "user", content: `对话:\n${digest}` },
        ],
        tools: [],
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "text-delta") summary += e.text
        },
      })
      void res
      const clean = summary.trim().slice(0, 1000)
      historyRef.current = [
        { role: "user", content: "(上下文已压缩, 以下是此前的会话摘要)" },
        { role: "assistant", content: `[上下文摘要]\n${clean}` },
      ]
      pushMsg({ kind: "verdict", ok: true, text: "上下文已压缩", detail: [clean.slice(0, 400)], ts: Date.now() })
      log.info("tui", "/compact 完成", { from: hist.length, to: 2 })
    } catch (e) {
      pushMsg({ kind: "danger", text: `压缩失败: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() })
    } finally {
      clearTimeout(timer)
    }
  }

  // 面板焦点导航: 扁平节点列表(选择序号)
  const flatNodes: Array<{ id: string }> = []
  if (activity.state.tree) {
    for (const w of activity.state.tree.children) {
      if (!w.id.startsWith("wave_")) continue
      for (const n of w.children) flatNodes.push({ id: n.id })
    }
  }

  // 领衔快捷键分发: 执行命名动作(复用 / 命令语义, 对齐 opencode ctrl+x leader)
  function dispatchLeader(action: string): void {
    const actions: Record<string, () => void> = {
      undo: () => {
        const r = undoChanges()
        pushMsg({ kind: "info", text: r.msg, detail: r.restored.map((p) => `恢复 ${relative(cwd, p)}`), ts: Date.now() })
      },
      redo: () => {
        const r = redoChanges()
        pushMsg({ kind: "info", text: r.msg, detail: r.restored.map((p) => `重做 ${relative(cwd, p)}`), ts: Date.now() })
      },
      new: () => {
        historyRef.current = []
        setMsgs([])
        activity.end()
        setDiag([])
        sessionIdRef.current = newSessionId(cwd)
        scrollToBottom()
      },
      sessions: () => {
        const list = listSessions()
        if (!list.length) {
          pushMsg({ kind: "info", text: "暂无已保存的会话", ts: Date.now() })
          return
        }
        const detail = list.map((s, i) => `${i + 1}. ${s.firstMsg}  (${s.msgs} 条消息, ${new Date(s.createdAt).toLocaleString()})`)
        pendingSessionsRef.current = list.map((s, i) => ({ id: s.id, label: s.firstMsg }))
        pushMsg({ kind: "info", text: `会话列表(输入序号恢复, 如 1):`, detail, ts: Date.now() })
      },
      themes: () => setThemeName((prev) => (prev === "dark" ? "light" : "dark")),
      models: () => {
        pushMsg({
          kind: "info",
          text: "当前模型:",
          detail: [`LLM_MODEL = ${process.env.LLM_MODEL ?? "(未设置)"}`, `LLM_URL = ${process.env.LLM_URL ?? process.env.API_URL ?? "(未设置)"}`, "换模型: /config 修改后保存即生效"],
          ts: Date.now(),
        })
      },
      export: () => void exportTranscript(),
      editor: () => void composeInEditor(),
      compact: () => void compactHistory(),
      diag: () => setDiagOpen((v) => !v),
      help: () => pushMsg({ kind: "info", text: "命令列表(ctrl+x + 字母为快捷键 · Tab 补全 / 命令):", detail: helpLines(), ts: Date.now() }),
      quit: () => exit(),
    }
    actions[action]?.()
  }

  function clearLeader(): void {
    const l = leaderRef.current
    if (l.timer) clearTimeout(l.timer)
    l.target = null
    l.timer = null
    setLeaderHint(null)
  }

  function armLeader(): void {
    const l = leaderRef.current
    if (l.timer) clearTimeout(l.timer)
    l.target = "armed"
    l.timer = setTimeout(clearLeader, LEADER_TIMEOUT_MS)
    setLeaderHint("ctrl+x + 字母: u撤销 r重做 n新会话 l会话 t主题 m模型 e编辑器 x导出 c压缩 d诊断 q退出")
  }

  useInput((ch, key) => {
    // 领衔快捷键第二键(任何状态优先)
    if (leaderRef.current.target === "armed" && !key.ctrl) {
      clearLeader()
      const action = LEADER_KEYS[ch.toLowerCase()]
      if (action) dispatchLeader(action)
      return true // 吞掉, 不进入输入框
    }
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
      } else if (ch.toLowerCase() === "e") {
        setExpanded((prev) => (prev.size ? new Set() : new Set(flatNodes.map((n) => n.id))))
      }
      return true // 吞掉按键, 不让 TextInput 处理
    }
    // 视口滚动: 输入框为空时 ↑↓ 滚动(网页感); PgUp/PgDn/Home/End 始终可滚
    // 非空时 ↑↓ 留在输入框(输入导航优先) —— "越界才进入输入"
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
      if (key.upArrow || key.downArrow) {
        if (input.length > 0) return // 输入框有内容: 留给输入
      }
      const ref = scrollRef.current
      const m = metricsRef.current
      const viewH = Math.max(1, m.viewportRows - m.liveH)
      const maxOff = Math.max(0, totalHeight(m.heights) - viewH)
      // 贴底模式: 当前位置就是底部; 解锁后从记录的 offset 继续
      const cur = ref.lock ? maxOff : clampOffset(ref.offset, viewH, m.heights)
      const step = key.pageUp || key.pageDown ? Math.max(1, Math.floor(viewH * 0.6)) : 3
      let next: number
      if (key.upArrow || key.pageUp || key.home) {
        if (ref.lock) setScrollLock(false) // 首次上滚: 解除贴底
        next = key.home ? 0 : Math.max(0, cur - step)
      } else {
        next = key.end ? maxOff : Math.min(maxOff, cur + step)
        if (next >= maxOff) setScrollLock(true) // 滚到底: 恢复贴底
      }
      setScrollOffset(next)
      return true
    }
    if (key.tab) {
      // @ 文件补全: 输入以 @query 结尾且有候选时, Tab 补全第一个(对齐 opencode @ 引用)
      if (atQuery && atCands.length > 0) {
        setInput((prev) => {
          const m = prev.match(/(?:^|\s)@([^\s@]+)$/)
          if (!m) return prev
          const full = m[0]
          const prefix = full.slice(0, full.indexOf("@"))
          return `${prev.slice(0, prev.length - full.length)}${prefix}@${atCands[0]} `
        })
        return true
      }
      // / 命令补全: 输入以 / 开头且有候选时, Tab 补全第一个
      const candidates = matchCommands(input)
      if (candidates.length && !busy) {
        setInput(`/${candidates[0]!.name}`)
        return true
      }
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
    if (key.ctrl && ch.toLowerCase() === "u") {
      setInput("")
      return true
    }
    if (key.ctrl && ch.toLowerCase() === "x") {
      armLeader()
      return true
    }
    if (key.ctrl && ch.toLowerCase() === "p") {
      pushMsg({ kind: "info", text: "命令面板(ctrl+x + 字母为快捷键 · Tab 补全 / 命令):", detail: helpLines(), ts: Date.now() })
      return true
    }
    if (key.ctrl && ch.toLowerCase() === "o") {
      openConfig()
      return true
    }
    if (key.ctrl && ch.toLowerCase() === "d") {
      setDiagOpen((v) => !v)
      return true
    }
    if (key.escape) {
      if (busy) controllerRef.current?.abort()
      else if (leaderRef.current.target === "armed") clearLeader()
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
  // ---------- 视口度量: 终端尺寸 / 内容高度 / 虚拟窗口 ----------
  const { cols, rows } = useTerminalSize(stdout)
  // 外层留白 + 活动面板 32%(波次内容通常不长, 窄面板给对话更多空间)
  const mdWidth = Math.max(36, Math.floor((cols - 6) * (activityOpen ? 0.66 : 1)))
  // 固定 chrome: 顶部留白2 + 头部4(文字+下划线+内padding+下边距) + 输入框7(或设置面板) + 底部留白1
  // + 诊断托盘/命令候选/领衔提示(它们位于视口与输入框之间, 必须计入, 否则输入框被顶出屏幕)
  const cmdCandidates = !busy && input.startsWith("/") ? matchCommands(input) : []
  const atShow = atQuery && atCands.length > 0 ? atCands.slice(0, 3) : []
  // 鼠标: 点击右侧面板的节点行 → 展开/收起; 滚轮 → 面板内滚动(自研 SGR 协议, 零依赖)。
  // 命中检测复用与渲染相同的 computePanelLayout, 保证点击位置与显示位置一致。
  const panelTopRow = 2 + 4 + 1 // paddingTop 2 + Header 4 + border 1(与 chromeRows 对齐)
  const panelLeftCol = 2 + mdWidth + 3 + 1 + 2 // paddingX 2 + 左栏 + marginLeft 3 + border 1 + paddingLeft 2
  const mouseCbRef = useRef<(e: import("./mouse.tsx").MouseEventData) => void>(() => {})
  mouseCbRef.current = (e) => {
    if (!activityOpen) return
    const panelColHit = e.col >= panelLeftCol && e.col <= cols
    const panelRowHit = e.row >= panelTopRow && e.row < panelTopRow + viewportRows
    if (!panelColHit || !panelRowHit) return
    const layout = computePanelLayout(activity.state, {
      expanded,
      width: Math.floor((cols - 6) * 0.32),
      rows: viewportRows,
      focused: actFocus,
      sel,
    })
    if (e.button === 64 || e.button === 65) {
      // 滚轮: 面板内滚动(焦点模式, 选择跟随)
      setActFocus(true)
      const dir = e.button === 64 ? -1 : 1
      setSel((s) => (flatNodes.length ? (s < 0 ? 0 : (s + dir + flatNodes.length) % flatNodes.length) : -1))
      return
    }
    // 左键: 命中测试 → 选中该行并切换展开
    const localRow = e.row - panelTopRow
    let acc = 0
    for (let i = layout.start; i < layout.blocks.length; i++) {
      if (layout.rowHeights[i]! === 0) continue
      acc += layout.rowHeights[i]!
      if (localRow < acc) {
        const b = layout.blocks[i]!
        if (b.type === "node") {
          const idx = flatNodes.findIndex((f) => f.id === b.n.id)
          if (idx >= 0) {
            setActFocus(true)
            setSel(idx)
            setExpanded((prev) => {
              const next = new Set(prev)
              if (next.has(b.n.id)) next.delete(b.n.id)
              else next.add(b.n.id)
              return next
            })
          }
        }
        return
      }
    }
  }
  useMouse((e) => mouseCbRef.current(e), activityOpen)

  const chromeRows =
    2 + 4 + (settingsOpen ? 5 : 7) + 1 + (diagOpen ? 4 : 0) + Math.min(cmdCandidates.length, 4) + 1 + (leaderHint ? 2 : 0) + atShow.length + 2
  const viewportRows = Math.max(8, rows - chromeRows)
  // 贴底活动区(流式/拆解/执行过程 feed)高度: 滚动窗口之外, 永远钉在底部
  const liveH =
    (streamText ? estimateMarkdownHeight(streamText, Math.max(1, mdWidth - 2)) + 1 : 0) +
    (activity.state.phase === "decompose" ? 1 + estimateMarkdownHeight(activity.state.decomposeNote, Math.max(1, mdWidth - 2)) : 0) +
    (activity.state.phase === "run" ? estimateLiveProcessHeight(activity.state, Math.max(1, mdWidth - 2)) : 0)
  // 消息高度: 逐块估算(第 0 块无上边距)
  const heights = useMemo(() => msgs.map((m, i) => estimateMsgHeight(m, mdWidth) + (i === 0 ? 0 : 1)), [msgs, mdWidth])
  const totalH = totalHeight(heights)
  // 上滚指示条占 1 行, 计入视口余量
  const msgViewH = Math.max(1, viewportRows - liveH)
  // 贴底: 新内容自动滚到底; 手动上滚解锁后保持位置
  const effectiveOffset = scrollLock ? Math.max(0, totalH - msgViewH) : clampOffset(scrollOffset, msgViewH, heights)
  const win = computeWindow(heights, msgViewH, effectiveOffset)
  metricsRef.current = { viewportRows, heights, liveH }
  const slice = msgs.slice(win.start, win.end)
  const fillerRows = Math.max(0, msgViewH - win.startPad - win.visibleH)
  const spinnerChar = "⠋⠙⠹⠸"[spinner] ?? " "
  // 执行中 · 波次 X/Y(让状态栏说明"正在执行第几波")
  const liveWaves = activity.state.tree?.children.filter((w) => w.id.startsWith("wave_")) ?? []
  const curWave = liveWaves.findLastIndex((w) => w.status === "running" || w.status === "pending") + 1
  const phaseLabel =
    activity.state.phase === "decompose"
      ? "声明中"
      : activity.state.phase === "run"
        ? activity.state.running > 0
          ? `执行中 · 波次 ${curWave}/${liveWaves.length}`
          : "运行中"
        : ""
  // 拆解等待时长(由 spinner 每 120ms 的 tick 驱动重渲染)
  const decomposeSecs = decomposeStartRef.current ? Math.max(0, Math.floor((Date.now() - decomposeStartRef.current) / 1000)) : 0

  return (
    <Box flexDirection="column" width="100%" paddingX={2} paddingTop={2} paddingBottom={1}>
      <Header t={t} cwd={cwd} model={modelName} toolCount={tools.length} mode={mode} />
      {/* 主区: 左右两列, 高度固定(终端即网页视口)。左侧虚拟滚动, 右侧独立滚动 */}
      <Box flexDirection="row" width="100%" height={viewportRows}>
        <Box flexDirection="column" alignItems="flex-start" flexGrow={1} height="100%">
          {/* 欢迎卡片在视口内(msgs 为空时), 随对话滚动走, 不占用视口外高度 */}
          {msgs.length === 0 && <WelcomeCard cwd={cwd} model={modelName} toolCount={tools.length} t={t} />}
          {/* 已滚出提示(仅手动上滚解锁后显示) */}
          {!scrollLock && effectiveOffset > 0 && (
            <Text color={t.inkFaint} dimColor wrap="wrap">
              ↑ 已滚动 {effectiveOffset} 行 · ↓ 回到底部
            </Text>
          )}
          {/* 虚拟窗口: 只渲染视口内的消息 + 顶部对齐 + 底部填充 */}
          {slice.length > 0 && (
            <Box flexDirection="column" width="100%">
              {win.startPad > 0 && <Box height={win.startPad} />}
              {slice.map((m, i) => (
                <MsgBlock key={win.start + i} msg={m} t={t} width={mdWidth} first={win.start + i === 0} />
              ))}
            </Box>
          )}
          {fillerRows > 0 && <Box height={fillerRows} />}
          {/* 贴底活动区: 流式/拆解/执行过程, 永远钉在视口底部 */}
          {streamText && <StreamingBlock text={streamText} t={t} width={mdWidth} cursorOn={cursorOn} />}
          {activity.state.phase === "decompose" && <DecomposeLive note={activity.state.decomposeNote} secs={decomposeSecs} t={t} />}
          {activity.state.phase === "run" && <LiveProcess state={activity.state} t={t} width={mdWidth} now={Date.now()} />}
        </Box>
        {activityOpen && (
          <Box
            marginLeft={3}
            width="32%"
            flexShrink={0}
            height="100%"
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderColor={t.inkFaint}
            paddingLeft={2}
          >
            {/* 面板与主内容彻底解耦: 固定高度 + 独立虚拟滚动(焦点时跟随选中) */}
            <Box flexDirection="column" width="100%" height="100%">
              <ActivityPanel
                state={activity.state}
                t={t}
                focused={actFocus}
                sel={sel}
                expanded={expanded}
                now={Date.now()}
                width={Math.floor((cols - 6) * 0.32)}
                rows={viewportRows}
              />
              {actFocus && <Text color={t.inkFaint}>↑↓ 选择 · Enter 展开 · e 全开 · Esc 返回</Text>}
            </Box>
          </Box>
        )}
      </Box>
      {cmdCandidates.length > 0 && (
        <Box flexDirection="column" width="100%" marginTop={1}>
          {cmdCandidates.slice(0, 4).map((c) => (
            <Text key={c.name} color={t.inkFaint} wrap="wrap">
              /{c.name} — {c.desc}
            </Text>
          ))}
        </Box>
      )}
      {atShow.length > 0 && (
        <Box flexDirection="column" width="100%" marginTop={1}>
          {atShow.map((c) => (
            <Text key={c} color={t.inkFaint} wrap="wrap">
              @ {c}
            </Text>
          ))}
          <Text color={t.accent} dimColor>
            Tab 补全
          </Text>
        </Box>
      )}
      {leaderHint && (
        <Box flexDirection="column" width="100%" marginTop={1}>
          <Text color={t.accent} dimColor wrap="wrap">
            {leaderHint}
          </Text>
        </Box>
      )}
      {diagOpen && <DiagTray lines={diag} t={t} />}
      {settingsOpen ? (
        <SettingsPanel
          draft={configDraft}
          field={configField}
          t={t}
          onChange={(key, value) => setConfigDraft((d) => ({ ...d, [key]: value }))}
        />
      ) : (
        // 输入行: 圆角填充质感(有明确"输入框"认知), 固定在底部
        <Box
          marginTop={2}
          flexDirection="column"
          borderStyle="round"
          borderColor={actFocus ? t.accentDim : t.inkFaint}
          backgroundColor={t.codeBg}
          paddingX={2}
          paddingY={1}
        >
          <Box flexDirection="row">
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

// ---------- 拆解过程实时块 ----------
// 拆解阶段的 LLM 流式输出直接显示在对话流: "看得见过程", 不是黑盒等待。
// 同时显示已等待时长, 让用户确认任务在推进。

function DecomposeLive({ note, secs, t }: { note: string; secs: number; t: ThemeTokens }): ReactNode {
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
      <Text color={t.inkDim}>
        声明中… 正在生成执行声明(已等待 {secs}s)
        {secs > 10 && !note.trim() ? " · 模型未开始输出, 仍在等待首个响应" : ""}
      </Text>
      {note ? (
        <Text color={t.inkDim} dimColor wrap="wrap">
          {note}
          {note.length >= 600 ? "…" : ""}
        </Text>
      ) : (
        <Text color={t.inkFaint} dimColor wrap="wrap">
          等待模型返回计划 JSON…(此阶段通常 5-30s, 包含递归拆解)
        </Text>
      )}
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

// ---------- 执行过程实时块(并行构建的过程可视化) ----------
// 左侧对话流的"过程 feed": 显示当前执行波次的节点 + 运行中节点的流式输出。
// 并行构建是 MiniCode 的特性 —— 每个并行节点都看得见在动:
//   ⚡ 波次 2 · 2 并行
//     ✓ agent.read   3ms
//     ◐ llm  ▰▰▰▱▱▱ 0.8s
//       基于以下项目文件列表和 issues.md 内容, 生成一个 bash 脚本…
// 完成后由 verdict 接替, feed 自动消失(不污染对话历史)。

/** LiveProcess 渲染行数估算(贴底区高度用)。所有波次可见: 每个波次头部 1 行 + 每节点 1 行 + 内容行。 */
function estimateLiveProcessHeight(state: ActivityState, w: number): number {
  const waves = (state.tree?.children ?? []).filter((x) => x.id.startsWith("wave_"))
  if (!waves.length) return 0
  let h = 0
  for (const wave of waves) {
    h += 1 // 波次头
    for (const n of wave.children) {
      h += 1
      const st = state.streams.get(n.id)
      if (st) h += estimateMarkdownHeight(st.slice(-300), w)
    }
  }
  return h
}

/**
 * 执行过程实时 feed: 显示**所有波次**的节点与流式内容(不是只显示最后一个活动波次)。
 * 完成波次的内容留在 streams 里, 持续可见 —— 波次内容实时可读, 不只在结束后出现。
 * 贴底渲染在视口底部, 由 estimateLiveProcessHeight 计入视口余量。
 */
function LiveProcess({ state, t, width, now }: { state: ActivityState; t: ThemeTokens; width: number; now: number }): ReactNode {
  const waves = (state.tree?.children ?? []).filter((w) => w.id.startsWith("wave_"))
  if (!waves.length) return null
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
      {waves.map((w) => {
        const num = w.id.replace("wave_", "")
        const waveStartAt = state.waveStartAt.get(Number(num))
        const running = w.children.filter((c) => c.status === "running").length
        return (
          <Box key={w.id} flexDirection="column" width="100%">
            <Text color={t.accent} bold>
              {w.status === "done" ? "✓" : "⚡"} 波次 {num} · {w.children.length} 节点
              {w.children.length > 1 ? " · 并行" : ""}
              {running ? ` · ${running} 运行中` : w.status === "done" ? " · 完成" : ""}
            </Text>
            {w.children.map((n) => {
              const g = NODE_GLYPH[n.status]
              const elapsed = n.status === "running" && waveStartAt !== undefined ? (now - waveStartAt) / 1000 : undefined
              const bar = n.status === "running" ? ` ${progressBar(elapsed !== undefined ? elapsed / 1.5 : 0.2, 6)}` : ""
              const ms = n.ms !== undefined ? ` ${n.ms.toFixed(0)}ms` : elapsed !== undefined ? ` ${elapsed.toFixed(1)}s` : ""
              const stream = state.streams.get(n.id)
              const streamEmpty = !stream?.trim()
              return (
                <Box key={n.id} flexDirection="column" width="100%">
                  <Text wrap="wrap">
                    <Text color={t[g.color]} bold={n.status === "running"}>
                      {g.char} {n.label}
                    </Text>
                    <Text color={t.accent}>{bar}</Text>
                    <Text color={t.inkFaint}>{ms}</Text>
                    {n.error ? <Text color={t.err}> ✗ {n.error.slice(0, 60)}</Text> : null}
                  </Text>
                  {/* 流式内容实时可见; 完成节点也保留内容(流缓冲常驻到本轮结束) */}
                  {stream && (
                    <Text color={t.inkDim} dimColor wrap="wrap">
                      {stream.slice(-300)}
                      {stream.length >= 2000 ? "…" : ""}
                    </Text>
                  )}
                  {/* 模型不流式(内容一次性到达)时的安抚: 完成时输出会自动进入对话流 */}
                  {n.status === "running" && streamEmpty && elapsed !== undefined && elapsed > 3 && (
                    <Text color={t.inkFaint} dimColor wrap="wrap">
                      正在生成…(模型未流式返回, 完成时输出将显示在对话流)
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        )
      })}
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
