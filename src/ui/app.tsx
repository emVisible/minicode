// Ink TUI 根组件 —— 纯聊天界面(无工具调用)
//   内容层: 对话流(结构化 Msg[], 用户/助手/结论/警示/信息)
//   系统层: 头部 + 输入框 + 状态
// 交互: Enter 提交, ↑↓/PgUp/PgDn/Home/End 滚动历史, Tab 切换 对话/命令行 模式,
//       Esc 取消当前操作(不退出!), Ctrl+C 双击退出, Ctrl+x 领衔快捷键, Ctrl+o 独立配置面板
// 命令行模式: 输入直接当 shell 命令执行(cwd), 输出回显为结论块; 阻止嵌套调用本程序自身
// 数据目录: <cwd>/.minicode/(MINICODE_HOME 可覆盖) —— 会话/日志/配置都在项目内缓存

import React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import { basename, join } from "node:path"
import { spawn, execFile } from "node:child_process"
import { buildSystemPrompt } from "../prompt.ts"
import { createLLMClient } from "../llm.ts"
import { saveConfig, loadConfig, applyConfigToEnv, configPath, activeProvider, listProviders, switchProvider, saveProviderProfile, registerForcedEnv, resetForcedEnv, DEFAULT_PROVIDER, DEFAULT_CONTEXT_LIMIT } from "../config.ts"
import { log, logPath, logTail } from "../log.ts"
import { saveSession, renameSession, forkSession, deleteSession, listSessions, loadSession, newSessionId, latestSession, sessionsDirPath, setArchived } from "../session.ts"
import { recordUsage, usageDetailLines, flushUsage, fmtTokens, usageSummary } from "../usage.ts"
import { copyToClipboard } from "../clipboard.ts"
import { SettingsPanel } from "./settings.tsx"
import { Input, inputLineInfo } from "./input.tsx"
import { PalettePanel, type PaletteRow, type SessionRow } from "./palette.tsx"
import { renderMarkdown, displayWidth, truncateTo } from "./markdown.tsx"
import { tokens, initialThemeName } from "./theme.ts"
import type { ThemeTokens, ThemeName } from "./theme.ts"
import type { MinicodeConfig } from "../config.ts"
import type { ChatMsg, DiagLine } from "../types.ts"
import { useTerminalSize, estimateMsgHeight, estimateMarkdownHeight, computeWindow, totalHeight, clampOffset, clipTextRows, clipTextRowsKeep, bubbleWidth } from "./viewport.tsx"
import { COMMANDS, LEADER_KEYS, LEADER_TIMEOUT_MS, rankCommands, PALETTE_MAX_ROWS, transcriptName } from "../commands.ts"
import { matchDanger } from "../danger.ts"
import { StatusLine, formatDuration } from "./statusline.tsx"
import { walkHistory, rememberInput } from "../input-history.ts"
import { MINICODE_VERSION } from "../version.ts"

// 渲染错误边界: ink 自带 ErrorBoundary 的 onError 会直接退出整个 TUI, 我们包自己的边界就地显示
class AppErrorBoundary extends React.Component<{ children: ReactNode; onError?: (e: Error) => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error): void {
    this.props.onError?.(error)
  }
  render(): ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="#e06c75" bold wrap="wrap">
            ✗ 界面渲染出错(已就地显示, 未退出)
          </Text>
          <Text color="#e06c75" wrap="wrap">
            {String(this.state.error.message).slice(0, 300)}
          </Text>
          <Text color="#808080" wrap="wrap">
            /new 重试, 或按 Esc 退出。错误已写入日志。
          </Text>
        </Box>
      )
    }
    return this.props.children
  }
}

export default function App({ cwd, theme, resume, mouseBus }: { cwd: string; theme?: ThemeName; resume?: boolean; mouseBus?: import("./mouse.tsx").MouseBus }): ReactNode {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const client = useMemo(() => createLLMClient(), [])
  const system = useMemo(() => buildSystemPrompt({ cwd }), [cwd])

  // ---------- 主题 / 外观(可持久化到配置) ----------
  const [themeName, setThemeName] = useState<ThemeName>(() => {
    const cfg = loadConfig()
    return cfg.theme ?? theme ?? initialThemeName()
  })
  const t = useMemo<ThemeTokens>(() => tokens(themeName), [themeName])
  const [dense, setDense] = useState<boolean>(() => loadConfig().dense === true)
  function persistTheme(next: ThemeName | ((prev: ThemeName) => ThemeName)): void {
    setThemeName((prev) => {
      const n = typeof next === "function" ? next(prev) : next
      try {
        saveConfig({ ...loadConfig(), theme: n })
      } catch {
        /* 只写失败不影响界面 */
      }
      return n
    })
  }
  function toggleDense(): void {
    setDense((prev) => {
      const next = !prev
      try {
        saveConfig({ ...loadConfig(), dense: next })
      } catch {
        /* 只写失败不影响界面 */
      }
      return next
    })
  }

  // ---------- 内容层: 结构化消息流 ----------
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState("")
  const [streamText, setStreamText] = useState("")
  const [streamThink, setStreamThink] = useState("")
  // 思考过程展开状态(按消息索引; 仅 UI 态, 不落盘)
  const [thinkOpen, setThinkOpen] = useState<ReadonlySet<number>>(new Set())
  const toggleThink = (i: number): void => {
    setThinkOpen((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  const [cursorOn, setCursorOn] = useState(true)

  // ---------- 系统层: 状态 ----------
  const [busy, setBusy] = useState(false)
  const [spinner, setSpinner] = useState(0)
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [configDraft, setConfigDraft] = useState<MinicodeConfig>({})
  const [configField, setConfigField] = useState(0)
  // 输入模式: chat=对话(LLM), shell=命令行(直接执行)
  const [mode, setMode] = useState<"chat" | "shell">("chat")
  // shell 子进程(供 Esc/Ctrl+C 中断)
  const shellProcRef = useRef<import("node:child_process").ChildProcess | null>(null)
  const historyRef = useRef<import("../types.ts").ChatMessage[]>([])
  const controllerRef = useRef<AbortController | null>(null)
  const sessionIdRef = useRef(newSessionId(cwd))

  // ---- v0.7 体验层: 状态行 / context 提醒 / 通知 / 终端标题 ----
  const [cfgTick, setCfgTick] = useState(0)
  const [tlTick, setTlTick] = useState(0)
  const sessionStartRef = useRef(Date.now())
  // 上下文占用: 最近一轮的 inputTokens(≥ 一次有效往返), /compact 归零重计
  const ctxTokensRef = useRef(0)
  const ctxWarnRef = useRef<70 | 90 | null>(null)
  function toggleCfg(key: "statusline" | "notify"): void {
    const cfg = loadConfig()
    const next = !(cfg[key] !== false)
    try {
      saveConfig({ ...cfg, [key]: next })
    } catch {
      /* 只写失败不影响界面 */
    }
    setCfgTick((x) => x + 1)
  }
  const setTermTitle = (title: string): void => {
    try {
      stdout.write(`\x1b]0;${title}\u0007`)
    } catch {
      /* 静默: 不支持标题序列的终端忽略即可 */
    }
  }
  // 状态行秒级跳动(仅开启时维持一个 1s 定时器; 关闭即销毁)
  useEffect(() => {
    if (loadConfig().statusline === false) return
    const timer = setInterval(() => setTlTick((x) => x + 1), 1000)
    return () => clearInterval(timer)
  }, [cfgTick])
  const statuslineOn = loadConfig().statusline !== false
  const notifyOn = loadConfig().notify !== false
  const contextLimit = loadConfig().contextLimit ?? DEFAULT_CONTEXT_LIMIT

  // ---------- 输入历史(Ctrl+↑/↓, 会话级内存; 纯函数见 input-history.ts) ----------
  const inputHistRef = useRef<string[]>([])
  const inputHistIdxRef = useRef(-1)
  const inputHistDraftRef = useRef("")
  function histStep(dir: 1 | -1): void {
    // 从"未浏览"首次向上: 存下当前输入作草稿, 向下越界时还原
    if (dir === -1 && inputHistIdxRef.current === -1) inputHistDraftRef.current = input
    const r = walkHistory(inputHistRef.current, inputHistIdxRef.current, dir, inputHistDraftRef.current)
    inputHistIdxRef.current = r.idx
    setInput(r.value)
  }

  // --resume: 启动时恢复最近一次会话
  useEffect(() => {
    if (!resume) return
    const rec = latestSession()
    if (rec && rec.msgs.length) {
      sessionIdRef.current = rec.id
      historyRef.current = rec.history
      setMsgs(rec.msgs)
      log.info("tui", "--resume 恢复会话", { id: rec.id, msgs: rec.msgs.length })
    }
  }, [resume])

  // 首启引导: 未配置 LLM 连接时自动打开配置面板(Ctrl+o 随时可重开); 已配置不打扰
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    const cfg = loadConfig()
    const has = (process.env.LLM_URL ?? process.env.API_URL ?? cfg.llmUrl) && (process.env.LLM_MODEL ?? cfg.llmModel)
    if (!has) {
      setInput("")
      openConfig()
      pushMsg({ kind: "info", text: "首次使用: 请在上方面板配置 LLM(URL / Key / 模型), Enter 保存即生效", ts: Date.now() })
    }
  }, [])

  // ---------- 视口滚动 ----------
  const [scrollOffset, setScrollOffset] = useState(0)
  const [scrollLock, setScrollLock] = useState(true)
  // 长输入预览窗: 输入过长时弹出独立查看/确认窗(Enter 确认发送, Esc 收起继续编辑)
  const [previewOpen, setPreviewOpen] = useState(false)
  const PREVIEW_LINES = 7
  // ---------- 命令面板(Ctrl+P / 输入 "/" 打开; 全界面唯一的提示区) ----------
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [palettePhase, setPalettePhase] = useState<"commands" | "sessions">("commands")
  const [paletteQuery, setPaletteQuery] = useState("")
  const [paletteSel, setPaletteSel] = useState(0)
  /** sessions 阶段: "browse" 浏览 / "rename" 输入新名字(Enter 提交, Esc 放弃) */
  const [paletteMode, setPaletteMode] = useState<"browse" | "rename">("browse")
  /** 删除二次确认: 记录上一个按 d 的目标, 再按才真删 */
  const paletteDeleteIdRef = useRef<string | null>(null)
  const paletteSessionsRef = useRef<Array<{ id: string; label: string; meta: string }>>([])
  const paletteRestoreRef = useRef("")
  const scrollRef = useRef({ offset: 0, lock: true })
  scrollRef.current = { offset: scrollOffset, lock: scrollLock }
  const metricsRef = useRef({
    viewportRows: 20,
    heights: [] as number[],
    msgs: [] as ChatMsg[],
    dense: false,
    thinkOpen: new Set<number>() as ReadonlySet<number>,
    segStart: 0,
    segEnd: 0,
    startPad: 0,
    topExtraRows: 0,
  })
  const scrollToBottom = (): void => {
    setScrollOffset(Number.MAX_SAFE_INTEGER)
    setScrollLock(true)
  }
  const scrollBy = (delta: number): void => {
    const m = metricsRef.current
    const maxOff = Math.max(0, totalHeight(m.heights) - m.viewportRows)
    const base = scrollRef.current.lock ? maxOff : clampOffset(scrollRef.current.offset, m.viewportRows, m.heights)
    const next = Math.min(maxOff, Math.max(0, base + delta))
    if (next >= maxOff) {
      setScrollOffset(Number.MAX_SAFE_INTEGER)
      setScrollLock(true)
    } else {
      setScrollLock(false)
      setScrollOffset(next)
    }
  }

  // ---------- Ctrl+C 语义(对齐 opencode/Claude Code) ----------
  const ctrlCArmedRef = useRef(false)
  const ctrlCDisarmRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armCtrlC = (): void => {
    ctrlCArmedRef.current = true
    if (ctrlCDisarmRef.current) clearTimeout(ctrlCDisarmRef.current)
    ctrlCDisarmRef.current = setTimeout(() => {
      ctrlCArmedRef.current = false
    }, 3000)
  }
  const disarmCtrlC = (): void => {
    ctrlCArmedRef.current = false
    if (ctrlCDisarmRef.current) {
      clearTimeout(ctrlCDisarmRef.current)
      ctrlCDisarmRef.current = null
    }
  }

  // ---------- 诊断托盘(Ctrl+d) ----------
  const [diag, setDiag] = useState<DiagLine[]>([])
  const [diagOpen, setDiagOpen] = useState(false)
  function pushDiag(level: DiagLine["level"], text: string): void {
    setDiag((prev) => [...prev, { ts: Date.now(), level, text }].slice(-50))
  }

  // ---------- 打字机流式渲染 ----------
  // 双通道: text=正式回答(content), think=模型思考流(reasoning_content, DeepSeek 系)。
  // 思考型模型 content 全程为 null, 只发 reasoning_content —— 若不单独展示, 用户会看到
  // "长时间无任何输出"(实测 30s~2min+), 且整段回答都塞在思考里, 最终也会"无回复却显示完成"。
  const typeRef = useRef({ text: { target: "", shown: 0 }, think: { target: "", shown: 0 } })
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const TYPE_INTERVAL_MS = 12
  function typeTick(): void {
    typeTimerRef.current = null
    const tr = typeRef.current
    for (const ch of ["text", "think"] as const) {
      const st = tr[ch]
      if (st.shown >= st.target.length) continue
      const pending = st.target.length - st.shown
      const step = pending > 600 ? 8 : pending > 250 ? 4 : 2
      st.shown = Math.min(st.target.length, st.shown + step)
    }
    setStreamText(tr.text.target.slice(0, tr.text.shown))
    setStreamThink(tr.think.target.slice(0, tr.think.shown))
    if (tr.text.shown < tr.text.target.length || tr.think.shown < tr.think.target.length) {
      typeTimerRef.current = setTimeout(typeTick, TYPE_INTERVAL_MS)
    }
  }
  function pushType(text: string): void {
    const st = typeRef.current.text
    st.target += text
    if (!typeTimerRef.current && st.shown < st.target.length) {
      typeTimerRef.current = setTimeout(typeTick, TYPE_INTERVAL_MS)
    }
  }
  function pushThink(text: string): void {
    const st = typeRef.current.think
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
    const tr = typeRef.current
    const full = tr.text.target
    const think = tr.think.target
    tr.text.target = ""
    tr.text.shown = 0
    tr.think.target = ""
    tr.think.shown = 0
    setStreamText("")
    setStreamThink("")
    if (full.trim() || think.trim()) {
      if (full.trim()) {
        // 混合流: 回答为 text, 思考过程作为 think 保留(可展开查看)
        pushMsg({ kind: "assistant", text: full.trim(), think: think.trim() || undefined, ts: Date.now() })
      } else {
        // 纯思考型: 回答本身就在思考里
        pushMsg({ kind: "assistant", text: think.trim(), ts: Date.now() })
      }
    }
  }

  function pushMsg(m: ChatMsg): void {
    setMsgs((prev) => [...prev, m])
  }

  // ---------- 会话持久化: msgs 防抖落盘 ----------
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushSession = useRef<() => void>(() => {})
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const save = (): void => {
      saveSession({
        id: sessionIdRef.current,
        cwd,
        model: process.env.LLM_MODEL ?? "默认",
        createdAt: Date.now(),
        msgs,
        history: historyRef.current,
      })
    }
    saveTimerRef.current = setTimeout(save, 800)
    flushSession.current = save
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [msgs])

  // 退出兜底: 任何退出路径都先落盘
  useEffect(() => {
    return () => {
      flushSession.current()
    }
  }, [])

  /** 流式速率诊断 */
  const cpsRef = useRef({ chars: 0, last: performance.now() })
  const [cps, setCps] = useState(0)

  function openConfig(): void {
    setInput("")
    // 初值: 配置文件的持久化值优先(env 只是启动时的等值镜像, 且可能被覆盖)
    const cfg = loadConfig()
    setConfigDraft({
      llmUrl: process.env.LLM_URL ?? process.env.API_URL ?? cfg.llmUrl ?? "",
      llmApiKey: process.env.LLM_API_KEY ?? process.env.API_KEY ?? cfg.llmApiKey ?? "",
      llmModel: process.env.LLM_MODEL ?? cfg.llmModel ?? "",
    })
    setConfigField(0)
    setSettingsOpen(true)
  }
  /** /provider: 无参列出全部 provider 与当前项; 带参则创建(必要时)并切换, 立即按新快照重算进程 env */
  function applyProviderCommand(arg: string): void {
    if (!arg) {
      const { current, names } = listProviders()
      pushMsg({
        kind: "info",
        text: `当前 provider: ${current}`,
        detail: [...names.map((n) => `${n === current ? "→" : "  "} ${n}`), "切换: /provider <名字> · 环境变量 LLM_PROVIDER 可临时指定 · 编辑当前配置: /config"],
        ts: Date.now(),
      })
      return
    }
    switchProvider(arg)
    resetForcedEnv()
    applyConfigToEnv(loadConfig())
    const { current } = listProviders()
    const { llmUrl, llmModel } = loadConfig()
    pushMsg({
      kind: "info",
      text: `已切换 provider → ${current}`,
      detail: [`url  = ${llmUrl ?? "(未配置, 请 /config 填写)"}`, `model = ${llmModel ?? "(沿用默认)"}`],
      ts: Date.now(),
    })
  }

  function saveConfigPanel(): void {
    const prof = {
      url: configDraft.llmUrl?.trim() || undefined,
      apiKey: configDraft.llmApiKey?.trim() || undefined,
      model: configDraft.llmModel?.trim() || undefined,
    }
    saveProviderProfile(prof)
    if (prof.url) process.env.LLM_URL = prof.url
    if (prof.apiKey) process.env.LLM_API_KEY = prof.apiKey
    if (prof.model) process.env.LLM_MODEL = prof.model
    if (prof.url) registerForcedEnv("LLM_URL")
    if (prof.apiKey) registerForcedEnv("LLM_API_KEY")
    if (prof.model) registerForcedEnv("LLM_MODEL")
    setSettingsOpen(false)
    setInput("")
    pushMsg({ kind: "info", text: `✓ 设置已保存并生效 (${configPath()})`, ts: Date.now() })
  }

  const CONFIG_FIELDS: Array<{ key: keyof MinicodeConfig; label: string; placeholder: string; secret?: boolean }> = [
    { key: "llmUrl", label: "LLM URL", placeholder: "https://api.openai.com/v1" },
    { key: "llmApiKey", label: "API Key", placeholder: "sk-...", secret: true },
    { key: "llmModel", label: "Model", placeholder: "gpt-4o-mini" },
  ]

  /**
   * 对话执行: 直接流式调用 LLM(纯文本, 不调用任何工具)。
   * 请求历史: historyRef 累积 user/assistant 消息。
   */
  async function runChat(prompt: string, display: string): Promise<void> {
    setBusy(true)
    setSpinnerTimer()
    const controller = new AbortController()
    controllerRef.current = controller
    const t0 = Date.now()
    pushMsg({ kind: "user", text: display, ts: Date.now() })
    log.info("tui", "消息开始", { prompt: prompt.slice(0, 120) })
    historyRef.current = [...historyRef.current, { role: "user", content: prompt }]
    const messages: import("../types.ts").ChatMessage[] = [
      { role: "system", content: system },
      ...historyRef.current,
    ]
    setTermTitle(`minicode · ${modelName} · ${basename(cwd) || cwd}`)

    try {
      const result = await client.stream({
        messages,
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "think-delta") {
            pushThink(e.text)
          } else if (e.type === "text-delta") {
            pushType(e.text)
          } else {
            return
          }
          const now = performance.now()
          const c = cpsRef.current
          c.chars += e.text.length
          if (now - c.last >= 1000) {
            setCps(Math.round(c.chars / ((now - c.last) / 1000)))
            c.chars = 0
            c.last = now
          }
        },
      })
      commitStream()
      historyRef.current = [...historyRef.current, { role: "assistant", content: result.message.content }]
      // 用量账本: 成功/失败都计一次往返(usage 可能全 0)
      recordUsage({
        sessionId: sessionIdRef.current,
        model: modelName,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: Date.now() - t0,
      })
      // context 占用: 取最近一轮 inputTokens(> 0 才可信), 70%/90% 各提示一次(每轮至多一条)
      if (result.usage.inputTokens > 0) {
        ctxTokensRef.current = result.usage.inputTokens
        const pct = Math.round((ctxTokensRef.current / Math.max(1, contextLimit)) * 100)
        if (pct >= 90 && ctxWarnRef.current !== 90) {
          ctxWarnRef.current = 90
          pushMsg({ kind: "danger", text: `上下文占用已达 ${pct}%(${ctxTokensRef.current}/${contextLimit} tokens), 建议 /compact 压缩后继续`, ts: Date.now() })
        } else if (pct >= 70 && ctxWarnRef.current === null) {
          ctxWarnRef.current = 70
          pushMsg({ kind: "info", text: `上下文占用 ${pct}%(${ctxTokensRef.current}/${contextLimit} tokens), 接近上限时可 /compact`, ts: Date.now() })
        }
      }
      const usageLine =
        result.usage.totalTokens > 0 ? `↑${result.usage.inputTokens} ↓${result.usage.outputTokens} · ${((Date.now() - t0) / 1000).toFixed(1)}s` : undefined
      // 长回答完成通知(BEL + OSC 9): ≥ 8s 才打扰, 中断/失败不通知
      const elapsed = Date.now() - t0
      if (notifyOn && elapsed >= 8000 && result.finish !== "aborted" && result.finish !== "error") {
        try {
          stdout.write(`\u0007\x1b]9;minicode: 回答完成 · ${Math.round(elapsed / 1000)}s\u0007`)
        } catch {
          /* 静默 */
        }
      }
      if (result.finish === "aborted") {
        pushMsg({ kind: "danger", text: "已中断", ts: Date.now() })
      } else if (result.finish === "length" || result.finish === "content_filter" || result.finish === "error") {
        pushMsg({ kind: "danger", text: `回答被截断/终止 (finish=${result.finish})`, ts: Date.now() })
      } else {
        pushMsg({ kind: "verdict", ok: true, text: "完成", detail: usageLine ? [usageLine] : undefined, ts: Date.now() })
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("429")) {
          // 限流: 给可行动作, 而不是干巴巴的 HTTP 码
          const { today } = usageSummary()
          pushMsg({
            kind: "danger",
            text: `限流了(HTTP 429): 请求过密或额度已用尽`,
            detail: [
              msg.slice(0, 160),
              `今日用量: ${today.turns} 轮 · ↑${fmtTokens(today.inputTokens)} ↓${fmtTokens(today.outputTokens)}`,
              "建议: 稍等重试; 持续出现请检查 provider 余额/配额, 或调低 contextLimit(/config)",
            ],
            ts: Date.now(),
          })
        } else {
          pushMsg({ kind: "danger", text: msg, ts: Date.now() })
        }
      }
    }
    commitStream()
    const c = cpsRef.current
    c.chars = 0
    c.last = performance.now()
    setCps(0)
    if (spinnerTimerRef.current) {
      clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
    controllerRef.current = null
    setBusy(false)
    setTermTitle("")
  }

  /**
   * 命令行模式: 把输入直接当 shell 命令执行(cwd=当前项目), 输出回显为结论块。
   * 防嵌套: 命令里出现 minicode 自身调用(本程序/pnpm dev/npm start 等)直接拒绝,
   * 避免"命令行模式里再起一个 TUI"的循环。
   */
  async function runShell(cmd: string): Promise<void> {
    const low = cmd.toLowerCase()
    if (/\b(minicode|tsx src\/cli|pnpm (dev|run)|npm (run )?(dev|start)|yarn (dev|start))\b/.test(low)) {
      pushMsg({
        kind: "danger",
        text: "已阻止该命令: 它会在命令行模式里再次启动本工具(嵌套 TUI), 如需运行请退出后用终端执行",
        ts: Date.now(),
      })
      return
    }
    setBusy(true)
    setSpinnerTimer()
    pushMsg({ kind: "user", text: `$ ${cmd}`, ts: Date.now() })
    log.info("tui", "shell 执行", { cmd: cmd.slice(0, 120), cwd })
    const t0 = Date.now()
    // execFile 直接走 cwd, 回调风格避免阻塞事件循环; 30s 超时熔断
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string; timeout: boolean }>((resolve) => {
      const child = execFile("/bin/sh", ["-c", cmd], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
        shellProcRef.current = null
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
        if (e && e.killed) {
          resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", timeout: true })
        } else {
          resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: stdout ?? "", stderr: stderr ?? "", timeout: false })
        }
      })
      shellProcRef.current = child
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const linesOut = out.stdout.split("\n").filter((l) => l.trim())
    const linesErr = out.stderr.split("\n").filter((l) => l.trim())
    const tail = (arr: string[], max = 30): string[] => (arr.length > max ? [...arr.slice(0, 3), `…(共 ${arr.length} 行, 仅显示前 30)`] : arr)
    if (out.timeout) {
      pushMsg({ kind: "danger", text: `命令超时(>30s)已终止`, detail: tail(linesOut.concat(["—— stderr ——"]).concat(linesErr)), ts: Date.now() })
    } else if (out.code === 0) {
      pushMsg({ kind: "verdict", ok: true, text: `退出码 0 · ${secs}s`, detail: tail(linesOut), ts: Date.now() })
    } else {
      pushMsg({ kind: "danger", text: `退出码 ${out.code ?? "?"} · ${secs}s`, detail: tail([...linesErr, ...linesOut]), ts: Date.now() })
    }
    if (spinnerTimerRef.current) {
      clearInterval(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
    setBusy(false)
  }

  // ---------- 命令面板 ----------
  const paletteScopedRef = useRef<"active" | "archived">("active")
  /** 会话面板行(首位=新建动作, 对标 opencode 的 + 置顶) */
  function refreshPaletteSessions(): void {
    paletteSessionsRef.current = [
      ...(paletteScopedRef.current === "archived" ? [] : [{ id: "__new__" as string, label: "＋ 新会话", meta: "" }]),
      ...listSessions()
        .filter((s) => (paletteScopedRef.current === "archived" ? s.archived : !s.archived))
        .map((s) => ({
          id: s.id,
          label: (s.archived ? "[已归档] " : "") + (s.title ?? s.firstMsg).replaceAll("\n", " "),
          meta: `${relTime(s.createdAt)} · ${s.msgs} 条`,
        })),
    ]
    setPaletteSel((sel) => Math.min(sel, Math.max(0, paletteSessionsRef.current.length - 1)))
  }
  function openPalette(phase: "commands" | "sessions" = "commands", query = "", scope: "active" | "archived" = "active"): void {
    paletteScopedRef.current = scope
    if (phase === "sessions") refreshPaletteSessions()
    if (!paletteOpen) paletteRestoreRef.current = input // 记住打开前的草稿, 关闭时还回去
    setPaletteMode("browse")
    paletteDeleteIdRef.current = null
    setPalettePhase(phase)
    setPaletteQuery(query)
    setPaletteSel(0)
    setPaletteOpen(true)
    setInput("")
  }
  function closePalette(): void {
    setPaletteOpen(false)
    setPaletteMode("browse")
    paletteDeleteIdRef.current = null
    setInput(paletteRestoreRef.current)
  }
  /** 提交重命名(输入框内容即新名字) */
  function commitPaletteRename(): void {
    const s = paletteSessionsRef.current[paletteSel]
    if (s) {
      renameSession(s.id, paletteQuery)
      refreshPaletteSessions()
    }
    setPaletteMode("browse")
  }
  /** 把当前会话复制为分支并切过去 */
  function forkCurrentSession(): void {
    flushSession.current()
    const rec = forkSession(sessionIdRef.current)
    if (!rec) {
      pushMsg({ kind: "danger", text: "分支失败", ts: Date.now() })
      return
    }
    sessionIdRef.current = rec.id
    historyRef.current = rec.history
    pushMsg({ kind: "verdict", ok: true, text: "已分支为新会话", detail: [rec.title ?? ""], ts: Date.now() })
  }
  function toggleMode(): void {
    setMode((m) => (m === "chat" ? "shell" : "chat"))
  }
  /** 新会话: 先把当前会话完整落盘, 再清空视口(上一会话保留在列表, 可随时恢复) */
  function startNewSession(): void {
    shellAllowAllRef.current = false
    flushSession.current()
    historyRef.current = []
    setMsgs([])
    setDiag([])
    ctxTokensRef.current = 0
    ctxWarnRef.current = null
    inputHistRef.current = []
    inputHistIdxRef.current = -1
    inputHistDraftRef.current = ""
    sessionIdRef.current = newSessionId(cwd)
    sessionStartRef.current = Date.now()
    scrollToBottom()
    setInput("")
  }
  function restoreSession(id: string, label: string): void {
    if (busy) {
      pushMsg({ kind: "info", text: "运行中无法切换会话, 先按 Esc / Ctrl+C 中断", ts: Date.now() })
      return
    }
    const rec = loadSession(id)
    if (!rec) {
      closePalette()
      pushMsg({ kind: "danger", text: "会话加载失败", ts: Date.now() })
      return
    }
    sessionIdRef.current = rec.id
    historyRef.current = rec.history
    setMsgs(rec.msgs)
    scrollToBottom()
    closePalette()
  }
  function copyMsg(kind: "assistant" | "user", what: string): void {
    const last = [...msgs].reverse().find((m) => m.kind === kind)
    if (!last) {
      pushMsg({ kind: "info", text: `还没有可复制的${what}`, ts: Date.now() })
      return
    }
    const r = copyToClipboard(last.text)
    pushMsg({ kind: r.ok ? "verdict" : "danger", ok: r.ok, text: r.msg, detail: r.ok ? [last.text.slice(0, 80)] : undefined, ts: Date.now() })
  }
  /** 面板命令执行(名字 = COMMANDS[].name; 无匹配回退到时序分发表) */
  const mruRef = useRef<Record<string, number>>({})
  function runPaletteCommand(name: string): void {
    mruRef.current[name] = Date.now()
    if (busy && !["help", "sessions", "usage", "models", "log", "status", "archived", "update"].includes(name)) {
      // 运行中执行 new/compact/quit 等会打断流式状态; 只允许查看类的命令
      closePalette()
      pushMsg({ kind: "info", text: "运行中: 先按 Esc / Ctrl+C 中断, 再执行该命令", ts: Date.now() })
      return
    }
    switch (name) {
      case "sessions":
        openPalette("sessions")
        return
      case "help":
        openPalette("commands")
        return
      case "compact":
        void compactHistory()
        break
      case "fork":
        forkCurrentSession()
        break
      case "connect":
        openConfig()
        break
      case "mode":
        toggleMode()
        break
      case "log":
        pushMsg({ kind: "info", text: `日志文件: ${logPath()}`, detail: logTail(40), ts: Date.now() })
        break
      case "status":
        submit("/status")
        break
      case "statusline":
        submit("/statusline")
        break
      case "notify":
        submit("/notify")
        break
      case "usage":
        pushMsg({ kind: "info", text: "用量统计:", detail: usageDetailLines(sessionIdRef.current), ts: Date.now() })
        break
      case "archived":
        openPalette("sessions", "", "archived")
        break
      case "archive":
        submit("/archive")
        break
      case "provider":
        applyProviderCommand("")
        break
      default:
        dispatchLeader(name)
        break
    }
    if (!["sessions", "help"].includes(name)) closePalette()
  }

  function submit(value: string): void {
    const trimmed = value.trim()
    if (!trimmed) return
    if (busy) {
      pushMsg({ kind: "info", text: "上一轮仍在运行, 按 Esc / Ctrl+C 中断后再输入", ts: Date.now() })
      return
    }
    if (mode === "shell") {
      setInput("")
      const danger = matchDanger(trimmed)
      if (danger && !shellAllowAllRef.current) {
        setConfirmReq({ cmd: trimmed, hint: danger.hint })
        return
      }
      void runShell(trimmed)
      return
    }
    if (trimmed === "/quit" || trimmed === "/exit") {
      flushSession.current()
      setTermTitle("")
      exit()
      return
    }
    if (trimmed === "/log") {
      pushMsg({ kind: "info", text: `日志文件: ${logPath()}`, detail: logTail(40), ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/update") {
      const { today } = usageSummary()
      pushMsg({
        kind: "info",
        text: `v${MINICODE_VERSION} · 更新提示`,
        detail: [
          `今日 LLM 用量: ${today.turns} 轮 · ↑${fmtTokens(today.inputTokens)} ↓${fmtTokens(today.outputTokens)}`,
          "升级方式: 重新运行安装脚本(install.sh)覆盖 dist 即完成; 本目录 pnpm dev 开发无需理会",
        ],
        ts: Date.now(),
      })
      setInput("")
      return
    }
    if (trimmed === "/sessions" || trimmed === "/resume") {
      openPalette("sessions")
      return
    }
    if (trimmed === "/archived") {
      openPalette("sessions", "", "archived")
      return
    }
    if (trimmed === "/archive") {
      const id = sessionIdRef.current
      flushSession.current()
      setArchived(id, true)
      pushMsg({ kind: "verdict", ok: true, text: "当前会话已归档", detail: ["会话列表隐藏, /archived 可随时查看恢复"], ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/sessions_dir" || trimmed === "/sdir") {
      pushMsg({ kind: "info", text: `会话目录: ${sessionsDirPath()}`, ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/reset" || trimmed === "/new" || trimmed === "/clear") {
      startNewSession()
      pushMsg({ kind: "verdict", ok: true, text: "已开始新会话", detail: ["上一会话已保存 · Ctrl+P → 会话 可随时恢复"], ts: Date.now() })
      return
    }
    if (trimmed === "/help") {
      openPalette("commands")
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
      const next = themeName === "dark" ? "light" : "dark"
      persistTheme(next)
      pushMsg({ kind: "info", text: `已切换为主题 ${next}(已保存到配置) · /dense 可调消息间距`, ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/dense") {
      toggleDense()
      pushMsg({ kind: "info", text: dense ? "已切换为宽松间距" : "已切换为紧凑间距", ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/statusline") {
      toggleCfg("statusline")
      pushMsg({ kind: "info", text: loadConfig().statusline === false ? "状态行已关闭(/statusline 再开)" : "状态行已开启", ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/notify") {
      toggleCfg("notify")
      pushMsg({ kind: "info", text: loadConfig().notify === false ? "完成通知已关闭(/notify 再开)" : "完成通知已开启(≥8s 的长回答会提醒)", ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/status") {
      const ctx = ctxTokensRef.current
      const pct = contextLimit > 0 ? Math.round((ctx / contextLimit) * 100) : 0
      pushMsg({
        kind: "info",
        text: `会话总览 · @${activeProvider()}`,
        detail: [
          `model      : ${modelName}`,
          `url        : ${process.env.LLM_URL ?? process.env.API_URL ?? "(未设置)"}`,
          "",
          `session    : ${sessionIdRef.current.slice(0, 12)}… · ${msgs.length} 条消息 · 已用 ${formatDuration(Date.now() - sessionStartRef.current)}`,
          `上下文占用 : ${pct}% (${ctx} / ${contextLimit} tokens)${pct >= 90 ? " · 已达上限, 建议 /compact" : pct >= 70 ? " · 接近上限" : ""}`,
          "",
          ...usageDetailLines(sessionIdRef.current),
          "",
          `状态行: ${statuslineOn ? "开" : "关"}(/statusline 切换) · 完成通知: ${notifyOn ? "开" : "关"}(/notify 切换)`,
        ],
        ts: Date.now(),
      })
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
    if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
      setInput("")
      applyProviderCommand(trimmed.slice("/provider".length).trim())
      return
    }
    if (trimmed === "/editor") {
      void composeInEditor()
      setInput("")
      return
    }
    // 长输入预览: 内容明显超出输入行可读范围时, 先弹「预览窗」确认(Enter 再发送, Esc 收起)
    if (!previewOpen && (trimmed.includes("\n") || displayWidth(trimmed) > mdWidth * 2 + 40)) {
      setPreviewOpen(true)
      pushMsg({ kind: "info", text: "输入较长, 已打开「长输入预览」: Enter 确认发送 · Esc 收起继续编辑", ts: Date.now() })
      return
    }
    setPreviewOpen(false)
    setInput("")
    inputHistRef.current = rememberInput(inputHistRef.current, trimmed)
    inputHistIdxRef.current = -1
    inputHistDraftRef.current = ""
    void runChat(trimmed, trimmed)
  }

  /** /export: 会话导出为 Markdown */
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

  /** /editor: 用外部编辑器撰写消息(GUI 编辑器后台拉起, 轮询文件变化) */
  async function composeInEditor(): Promise<void> {
    const editor = process.env.EDITOR
    if (!editor) {
      pushMsg({ kind: "info", text: "未设置 EDITOR 环境变量(如 export EDITOR=\"code --wait\")", ts: Date.now() })
      return
    }
    const { tmpdir } = await import("node:os")
    const { writeFileSync, readFileSync } = await import("node:fs")
    const { spawn } = await import("node:child_process")
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

  /** /compact: 长会话压缩为摘要(一次 LLM 调用, 无工具) */
  async function compactHistory(): Promise<void> {
    const hist = historyRef.current
    if (hist.length < 6) {
      pushMsg({ kind: "info", text: `上下文尚短(${hist.length} 条), 无需压缩`, ts: Date.now() })
      return
    }
    const t0 = Date.now()
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
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "text-delta") summary += e.text
        },
      })
      recordUsage({
        sessionId: sessionIdRef.current,
        model: modelName,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        latencyMs: Date.now() - t0,
      })
      void res
      const clean = summary.trim().slice(0, 1000)
      historyRef.current = [
        { role: "user", content: "(上下文已压缩, 以下是此前的会话摘要)" },
        { role: "assistant", content: `[上下文摘要]\n${clean}` },
      ]
      const usageLine = res.usage.totalTokens > 0 ? `↑${res.usage.inputTokens} ↓${res.usage.outputTokens} · ${((Date.now() - t0) / 1000).toFixed(1)}s` : undefined
      pushMsg({ kind: "verdict", ok: true, text: "上下文已压缩", detail: usageLine ? [usageLine, clean.slice(0, 400)] : [clean.slice(0, 400)], ts: Date.now() })
      // 压缩后上下文归零重计, 告警水位复位
      ctxTokensRef.current = 0
      ctxWarnRef.current = null
      log.info("tui", "/compact 完成", { from: hist.length, to: 2 })
    } catch (e) {
      pushMsg({ kind: "danger", text: `压缩失败: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() })
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------- 领衔快捷键(ctrl+x + 字母, 静默: 面板里有全表) ----------
  const leaderRef = useRef<{ target: string | null; timer: ReturnType<typeof setTimeout> | null }>({ target: null, timer: null })

  // 危险命令确认: 命中 matchDanger 的命令不直接执行, 先弹单键确认
  const [confirmReq, setConfirmReq] = useState<{ cmd: string; hint: string } | null>(null)
  /** [a] 本会话允许: 危险闸门本会话放行 */
  const shellAllowAllRef = useRef(false)

  function dispatchLeader(action: string): void {
    // busy 时只放行查看类; new/fork/quit/provider 会打断流式状态或改配置, 先中断再说
    if (busy && ["new", "fork", "quit", "provider"].includes(action)) {
      pushMsg({ kind: "info", text: "运行中: 先按 Esc / Ctrl+C 中断, 再执行该操作", ts: Date.now() })
      return
    }
    const actions: Record<string, () => void> = {
      new: () => {
        flushSession.current()
        historyRef.current = []
        setMsgs([])
        setDiag([])
        sessionIdRef.current = newSessionId(cwd)
        scrollToBottom()
      },
      sessions: () => openPalette("sessions"),
      themes: () => persistTheme(prev => (prev === "dark" ? "light" : "dark")),
  dense: () => toggleDense(),
      models: () => {
        pushMsg({
          kind: "info",
          text: "当前模型:",
          detail: [`LLM_MODEL = ${process.env.LLM_MODEL ?? "(未设置)"}`, `LLM_URL = ${process.env.LLM_URL ?? process.env.API_URL ?? "(未设置)"}`, "换模型: /config 修改后保存即生效"],
          ts: Date.now(),
        })
      },
      usage: () => pushMsg({ kind: "info", text: "用量统计:", detail: usageDetailLines(sessionIdRef.current), ts: Date.now() }),
      fork: () => forkCurrentSession(),
      provider: () => applyProviderCommand(""),
      export: () => void exportTranscript(),
      editor: () => void composeInEditor(),
      copy: () => copyMsg("assistant", "回答"),
      copyq: () => copyMsg("user", "问题"),
      diag: () => setDiagOpen((v) => !v),
      help: () => openPalette("commands"),
      quit: () => {
        flushSession.current()
        exit()
      },
    }
    actions[action]?.()
  }
  function clearLeader(): void {
    const l = leaderRef.current
    if (l.timer) clearTimeout(l.timer)
    l.target = null
    l.timer = null
  }
  function armLeader(): void {
    const l = leaderRef.current
    if (l.timer) clearTimeout(l.timer)
    l.target = "armed"
    l.timer = setTimeout(clearLeader, LEADER_TIMEOUT_MS)
  }
  function exitConfirmed(): void {
    flushUsage()
    flushSession.current()
    exit()
  }

  useInput((ch, key) => {
    // 危险命令确认: 单键回答前所有键归这里 —— [y] 执行一次 [a] 本会话允许 [Esc] 拒绝
    if (confirmReq) {
      if (key.escape) {
        pushMsg({ kind: "info", text: `已取消: ${confirmReq.hint}(${confirmReq.cmd.slice(0, 60)})`, ts: Date.now() })
        setConfirmReq(null)
      } else if (!key.ctrl && ch.toLowerCase() === "y") {
        const cmd = confirmReq.cmd
        setConfirmReq(null)
        void runShell(cmd)
      } else if (!key.ctrl && ch.toLowerCase() === "a") {
        const cmd = confirmReq.cmd
        setConfirmReq(null)
        shellAllowAllRef.current = true
        pushMsg({ kind: "info", text: `已放行本会话危险命令(请自行承担后果)`, ts: Date.now() })
        void runShell(cmd)
      }
      return true
    }
    function exitConfirmed(): void {
    flushSession.current()
    setTermTitle("")
    exit()
  }

  // Ctrl+C 语义: 忙时取消请求, 空闲首次提示; 3s 内再按退出; 其他按键解除
    if (key.ctrl && ch.toLowerCase() === "c") {
      if (ctrlCArmedRef.current) {
        exitConfirmed()
      } else if (busy) {
        controllerRef.current?.abort()
        armCtrlC()
        pushMsg({ kind: "info", text: "已取消当前回答 · 3 秒内再按 Ctrl+C 退出", ts: Date.now() })
      } else {
        armCtrlC()
        pushMsg({ kind: "info", text: "再按一次 Ctrl+C 退出(其他按键取消)", ts: Date.now() })
      }
      return true
    }
    if (ctrlCArmedRef.current) disarmCtrlC()
    // Ctrl+t: 展开/折叠最近一条含思考过程的回答(鼠标点击的键盘兜底 —— 部分终端不转发 SGR 鼠标序列)
    if (key.ctrl && ch.toLowerCase() === "t" && !busy && !paletteOpen && !settingsOpen) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const mm = msgs[i]!
        if (mm.kind === "assistant" && mm.think) {
          toggleThink(i)
          break
        }
      }
      return true
    }
    // 领衔快捷键第二键
    if (leaderRef.current.target === "armed" && !key.ctrl) {
      clearLeader()
      const action = LEADER_KEYS[ch.toLowerCase()]
      if (action) dispatchLeader(action)
      return true
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
    // 命令面板: 所有键归面板(过滤 → Enter 执行 → Esc 关闭; 会话阶段 d 删 r 改名)
    if (paletteOpen) {
      const palCount = palettePhase === "sessions" ? paletteSessionsRef.current.length : rankCommands(paletteQuery, mruRef.current).length
      if (key.escape) {
        if (paletteMode === "rename") setPaletteMode("browse")
        else closePalette()
      } else if (key.return) {
        if (paletteMode === "rename") {
          commitPaletteRename()
        } else if (palettePhase === "sessions") {
          const s = paletteSessionsRef.current[paletteSel]
          if (s) {
            if (s.id === "__new__") {
              startNewSession()
              closePalette()
            } else if (paletteScopedRef.current === "archived") {
              setArchived(s.id, false)
              restoreSession(s.id, s.label)
            } else {
              restoreSession(s.id, s.label)
            }
          }
        } else if (palCount === 0) {
          // 无匹配: 退回输入继续编辑(首字符 / 原样保留)
          paletteRestoreRef.current = "/" + paletteQuery
          setInput(paletteRestoreRef.current)
          closePalette()
        } else {
          runPaletteCommand(rankCommands(paletteQuery, mruRef.current)[Math.min(paletteSel, palCount - 1)]!.name)
        }
      } else if (paletteMode === "rename") {
        // 重命名模式: 输入框内容即新名字, 只允许编辑文本
        if (key.ctrl && ch.toLowerCase() === "u") setPaletteQuery("")
        else if (key.backspace) setPaletteQuery((q) => q.slice(0, -1))
        else if (!key.ctrl && !key.meta && !key.shift && ch) setPaletteQuery((q) => q + ch)
      } else if (!key.ctrl && !key.meta && !key.shift && ch === "d" && palettePhase === "sessions" && palCount > 0) {
        // d: 二次确认删除选中会话
        const target = paletteSessionsRef.current[paletteSel]!
        if (target.id === "__new__") {
          paletteDeleteIdRef.current = null
          return true
        }
        if (busy) {
          paletteDeleteIdRef.current = null
          pushMsg({ kind: "info", text: "运行中无法管理会话, 先按 Esc / Ctrl+C 中断", ts: Date.now() })
        } else if (target.id === sessionIdRef.current) {
          paletteDeleteIdRef.current = null
          pushMsg({ kind: "info", text: "当前会话不能删除", ts: Date.now() })
        } else if (paletteDeleteIdRef.current === target.id) {
          paletteDeleteIdRef.current = null
          deleteSession(target.id)
          refreshPaletteSessions()
          pushMsg({ kind: "verdict", ok: true, text: "会话已删除", detail: [target.label], ts: Date.now() })
        } else {
          paletteDeleteIdRef.current = target.id
          pushMsg({ kind: "info", text: `再按 d 删除: ${target.label}`, ts: Date.now() })
        }
      } else if (!key.ctrl && !key.meta && !key.shift && ch === "a" && palettePhase === "sessions" && palCount > 0) {
        // a: 归档/取消归档选中会话(可逆, 单键即生效)
        const target = paletteSessionsRef.current[paletteSel]!
        if (target.id === "__new__") {
          paletteDeleteIdRef.current = null
          return true
        }
        const next = paletteScopedRef.current !== "archived"
        setArchived(target.id, next)
        refreshPaletteSessions()
        pushMsg({ kind: "verdict", ok: true, text: next ? "会话已归档(a 可恢复)" : "会话已恢复", detail: [target.label], ts: Date.now() })
      } else if (!key.ctrl && !key.meta && !key.shift && ch === "r" && palettePhase === "sessions" && palCount > 0) {
        // r: 进入重命名, 输入框预填原名
        const target = paletteSessionsRef.current[paletteSel]!
        if (target.id === "__new__") {
          paletteDeleteIdRef.current = null
          return true
        }
        if (busy) {
          pushMsg({ kind: "info", text: "运行中无法管理会话, 先按 Esc / Ctrl+C 中断", ts: Date.now() })
        } else {
          paletteDeleteIdRef.current = null
          setPaletteQuery(target.label)
          setPaletteMode("rename")
        }
      } else if (key.tab || key.downArrow) {
        paletteDeleteIdRef.current = null
        setPaletteSel((s) => (s + 1) % Math.max(1, palCount))
      } else if (key.upArrow) {
        paletteDeleteIdRef.current = null
        setPaletteSel((s) => (s + Math.max(1, palCount) - 1) % Math.max(1, palCount))
      } else if (key.pageDown) {
        paletteDeleteIdRef.current = null
        setPaletteSel((s) => Math.min(Math.max(0, palCount - 1), s + PALETTE_MAX_ROWS))
      } else if (key.pageUp) {
        paletteDeleteIdRef.current = null
        setPaletteSel((s) => Math.max(0, s - PALETTE_MAX_ROWS))
      } else if (key.home) {
        paletteDeleteIdRef.current = null
        setPaletteSel(0)
      } else if (key.end) {
        paletteDeleteIdRef.current = null
        setPaletteSel(Math.max(0, palCount - 1))
      } else if (key.ctrl && ch.toLowerCase() === "u") {
        paletteDeleteIdRef.current = null
        setPaletteQuery("")
        setPaletteSel(0)
      } else if (key.backspace) {
        paletteDeleteIdRef.current = null
        setPaletteQuery((q) => q.slice(0, -1))
        setPaletteSel(0)
      } else if (!key.ctrl && !key.meta && !key.shift && ch) {
        paletteDeleteIdRef.current = null
        setPaletteQuery((q) => q + ch)
        setPaletteSel(0)
      }
      return true
    }
    // 视口滚动: 输入框为空时 ↑↓ 滚动; PgUp/PgDn/Home/End 始终可滚
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
      if (key.upArrow || key.downArrow) {
        if (input.length > 0) return
      }
      const m = metricsRef.current
      const step = key.pageUp || key.pageDown ? Math.max(1, Math.floor(m.viewportRows * 0.6)) : 3
      if (key.home) {
        setScrollLock(false)
        setScrollOffset(0)
      } else if (key.end) {
        scrollToBottom()
      } else if (key.upArrow || key.pageUp) {
        scrollBy(-step)
      } else {
        scrollBy(step)
      }
      return true
    }
    if (key.tab) {
      // 模式切换(静默, 头部状态同步变化); busy 时禁止
      if (busy) {
        pushMsg({ kind: "info", text: "运行中无法切换模式", ts: Date.now() })
        return true
      }
      toggleMode()
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
      openPalette("commands")
      return true
    }
    // "/" 首字符: 空输入敲 / 直接拉出命令面板(全部命令的入口)
    if (!paletteOpen && !busy && mode === "chat" && input === "" && ch === "/") {
      openPalette("commands")
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
    // 输入历史: Ctrl+↑/↓ 回填之前提交过的输入(仅对话区主上下文可用时; 面板/设置里不抢键)
    if (key.ctrl && key.upArrow) {
      histStep(-1)
      return true
    }
    if (key.ctrl && key.downArrow) {
      histStep(1)
      return true
    }
    if (key.escape) {
      // Esc 只用于"取消": 关闭面板/取消当前操作/中断请求; 绝不退出(退出只走 Ctrl+C 双击)
      if (previewOpen) {
        setPreviewOpen(false)
      } else if (settingsOpen) {
        setSettingsOpen(false)
        setInput("")
      } else if (leaderRef.current.target === "armed") {
        clearLeader()
      } else if (busy) {
        if (shellProcRef.current) {
          shellProcRef.current.kill("SIGTERM")
          pushMsg({ kind: "info", text: "已中断命令执行", ts: Date.now() })
        } else {
          controllerRef.current?.abort()
        }
      } else if (mode === "shell") {
        toggleMode()
      }
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

  function setSpinnerTimer(): void {
    spinnerTimerRef.current = setInterval(() => setSpinner((s) => (s + 1) % 4), 120)
  }

  const modelName = process.env.LLM_MODEL ?? "默认"
  const providerInfo = (() => {
    const p = listProviders()
    return p.current !== DEFAULT_PROVIDER ? p.current : null
  })()
  // ---------- 视口度量 ----------
  const { cols, rows } = useTerminalSize(stdout)
  const mdWidth = Math.max(36, cols - 6)

  // 鼠标: 滚轮滚动消息区 + 点击思考过程标题展开/折叠(自研 SGR 协议)
  const mouseCbRef = useRef<(e: import("./mouse.tsx").MouseEventData) => void>(() => {})
  mouseCbRef.current = (e) => {
    const m = metricsRef.current
    if (e.button === 64 || e.button === 65) {
      const dir = e.button === 64 ? -1 : 1
      const step = Math.max(3, Math.floor(Math.max(1, m.viewportRows) * 0.4))
      const ref = scrollRef.current
      const maxOff = Math.max(0, totalHeight(m.heights) - m.viewportRows)
      const base = ref.lock ? maxOff : clampOffset(ref.offset, m.viewportRows, m.heights)
      const next = Math.min(maxOff, Math.max(0, base + dir * step))
      if (next >= maxOff) {
        setScrollOffset(Number.MAX_SAFE_INTEGER)
        setScrollLock(true)
      } else {
        setScrollLock(false)
        setScrollOffset(next)
      }
      return
    }
    if (e.button !== 0) return
    // 左键: 命中思考过程标题/正文 → 展开/折叠
    // 视口区 = 顶部 pad(2)+header(4) 之下; 滚动提示行/空态提示也会占首行
    const y = e.row - 1 - 6 - m.topExtraRows
    if (y < 0) return
    let acc = -m.startPad
    const n = Math.min(m.segEnd, m.msgs.length)
    for (let i = m.segStart; i < n; i++) {
      const h = m.heights[i]!
      const msg = m.msgs[i]!
      if (msg.kind === "assistant" && msg.think) {
        const margin = i === 0 || m.dense ? 0 : 1
        const headerAt = acc + margin
        const thinkH = m.thinkOpen.has(i) ? estimateMarkdownHeight(msg.think, mdW) : 0
        // 标题行 + 展开后的正文行都可点击; 折叠态整个消息块可点(任意位置点击都能展开)
        if (m.thinkOpen.has(i)) {
          if (y >= headerAt && y < headerAt + 1 + thinkH) {
            toggleThink(i)
            return
          }
        } else {
          if (y >= headerAt && y < acc + h) {
            toggleThink(i)
            return
          }
        }
      }
      acc += h
    }
  }
  useEffect(() => {
    return mouseBus?.on((e) => mouseCbRef.current(e))
  }, [mouseBus])

  const mdW = Math.max(1, mdWidth - 2)
  // 面板(预览/确认)内容宽: 面板 border(2) + paddingX(2) 再吃掉 4 → 比 mdW 再窄 2
  // 内容宽必须与渲染实际一致, 否则内容按 mdW 折行、按面板宽再折 → 行数翻倍 → 帧超高
  const panelW = Math.max(1, mdW - 2)
  const previewLines = Math.min(PREVIEW_LINES, Math.max(1, Math.ceil(displayWidth(input) / panelW)))
  const palCount = paletteOpen ? (palettePhase === "sessions" ? paletteSessionsRef.current.length : rankCommands(paletteQuery, mruRef.current).length) : 0
  // 输入区动态行数(多行输入, 显示区上限 INPUT_MAX_ROWS; 计入视口 → 整帧高度恒定)
  const INPUT_MAX_ROWS = 3
  const spinnerChar = "⠋⠙⠹⠸"[spinner] ?? " "
  // 占位符与输入同口径计入行数: 空输入时输入块高度 = 占位符换行行数, 否则输入区撑高 1 行 → 帧高漂移
  const placeholder =
    busy
      ? mode === "shell"
        ? `执行中…(Esc 中断) ${spinnerChar}`
        : `生成中…(Esc 中断) ${spinnerChar}${cps ? ` · ${cps}c/s` : ""}${streamThink ? " · 思考中" : ""}`
      : mode === "shell"
        ? "命令行模式: 输入 shell 命令, Enter 执行 · Tab 切回对话"
        : "对话: 输入消息 (Ctrl+P 命令面板 · Tab 命令行 · Ctrl+o 配置 · Esc 取消)"
  const inputTotalLines = inputLineInfo(input || placeholder, mdW).rows
  const inputRows = Math.min(Math.max(1, inputTotalLines), INPUT_MAX_ROWS)
  // 覆盖层行数逐项精确(含各自 marginTop): 低估会让帧高超终端 → ink 每帧 clearTerminal(重影/卡顿)
  const diagRows = Math.min(8, diag.length)
  const overlayRows =
    (diagOpen ? 1 + 1 + diagRows : 0) /*margin+标题+行*/ +
    (confirmReq ? 2 + 2 + 1 + 3 : 0) /*margin+border+pad+内容*/ +
    (paletteOpen ? 11 + Math.min(palCount, PALETTE_MAX_ROWS) + (palCount > PALETTE_MAX_ROWS ? 1 : 0) : 0) /*margin+border+pad+⌘+query行+rows+溢出提示+foot*/ +
    (previewOpen ? 1 + 2 + 2 + 1 + previewLines : 0) /*margin+border+pad+head+内容*/ +
    (settingsOpen ? 1 + 1 + 4 + 1 + 1 : 0) /*margin+标题+字段区+底部提示*/
  const chromeRows = 2 /*paddingTop*/ + 4 /*header*/ + overlayRows + (1 + inputRows) /*输入块: marginTop + 显示行*/ + (statuslineOn ? 1 : 0)
  // 视口=剩余行, 下限 0 而非 8: 覆盖层(预览/面板)较矮时帧可精确=终端高;
  // 若硬保 8 行下限, 帧会超出终端 → ink 滚动后残影+光标错位
  const viewportRows = Math.max(0, rows - chromeRows)
  // 输入内容首行的绝对行号(0 基, 相对终端顶): 与 chromeRows 同源构造 → IME 光标 y 零漂移
  const inputTop = 2 + 4 + viewportRows + overlayRows + 1
  const heights = useMemo(() => {
    return msgs.map((m, i) => {
      let h = estimateMsgHeight(m, mdWidth) + (i === 0 || dense ? 0 : 1)
      // 思考过程块: 折叠=1 行标题, 展开=标题+思考正文(与 MsgBlock 渲染同口径)
      if (m.kind === "assistant" && m.think) {
        h += 1 + (thinkOpen.has(i) ? estimateMarkdownHeight(m.think, mdW) : 0)
      }
      return h
    })
  }, [msgs, mdWidth, dense, thinkOpen, mdW])
  const segHeights = [...heights]
  let liveStream = false
  if (streamText || streamThink) {
    liveStream = true
    const thinkH = streamThink ? estimateMarkdownHeight(streamThink, mdW) : 0
    segHeights.push(1 + thinkH + (thinkH > 0 && streamText ? 1 : 0) + estimateMarkdownHeight(streamText, mdW))
  }
  const docH = totalHeight(segHeights)
  const effectiveOffset = scrollLock ? Math.max(0, docH - viewportRows) : clampOffset(scrollOffset, viewportRows, segHeights)
  const win = computeWindow(segHeights, viewportRows, effectiveOffset)
  // 新增: 钉死渲染 → 帧高恒定(估算偏差由 overflow:hidden 兜底裁剪, 不再 residual 漂移)
  const topExtraRows = (msgs.length === 0 ? 2 : 0) + (!scrollLock && effectiveOffset > 0 ? 1 : 0)
  const msgBase = heights.length
  const segStart = win.start
  const segEnd = win.end
  const startPad = win.startPad
  const visibleH = win.visibleH
  const msgSlice = msgs.slice(Math.min(segStart, msgBase), Math.min(segEnd, msgBase))
  const liveBase = Math.max(0, segStart - msgBase)
  const liveEnd = Math.max(0, segEnd - msgBase)
  metricsRef.current = { viewportRows, heights: segHeights, msgs, dense, thinkOpen, segStart, segEnd, startPad, topExtraRows }
  const fillerRows = Math.max(0, viewportRows - (win.startPad + win.visibleH + win.endClip) - topExtraRows)
  const clipTopOfLive = (text: string, clip: number): string => (clip > 0 ? clipTextRows(text, clip, mdW) : text)

  return (
    <AppErrorBoundary onError={(e) => log.error("tui", "渲染错误", { message: e.message, stack: e.stack })}>
      <Box flexDirection="column" width="100%" paddingX={2} paddingTop={2} paddingBottom={0}>
        <Header t={t} cwd={cwd} model={providerInfo ? `${providerInfo} · ${modelName}` : modelName} width={mdWidth} />
        <Box flexDirection="column" width="100%" height={viewportRows} overflow="hidden">
          {msgs.length === 0 && (
            <Box flexDirection="column" width="100%">
              <Text color={t.accent} bold wrap="wrap">
                ↓ 输入你的问题开始对话
              </Text>
              <Text color={t.inkFaint} wrap="wrap">
                输入问题直接对话 · 前缀 / 呼出命令面板(Ctrl+P) · Tab 切换 对话/命令行 · Esc 取消 · 双击 Ctrl+C 退出
              </Text>
            </Box>
          )}
          {!scrollLock && effectiveOffset > 0 && (
            <Text color={t.inkFaint} dimColor wrap="wrap">
              ↑ 已滚动 {effectiveOffset} 行 · ↓ 回到底部
            </Text>
          )}
          {(msgSlice.length > 0 || (liveEnd > liveBase && liveStream)) && (
            <Box flexDirection="column" width="100%">
              {msgSlice.map((m, i) => {
                const segIdx = segStart + i
                const clipTop = segIdx === segStart && segStart < msgBase ? startPad : 0
                return (
                  <Box key={msgBase + i} height={segHeights[segIdx]!} overflow="hidden" flexDirection="column">
                    {segIdx > 0 && !dense && <Box height={1} />}
                    <MsgBlock msg={m} t={t} width={mdWidth} clipTop={clipTop} thinkOpen={thinkOpen.has(segIdx)} />
                  </Box>
                )
              })}
              {liveBase < liveEnd && liveStream && (
                <Box height={segHeights[segHeights.length - 1]!} overflow="hidden" flexDirection="column">
                  {(msgSlice.length > 0 || liveBase > 0) && !dense && <Box height={1} />}
                  {streamThink && (
                    <Text color={t.inkDim} wrap="wrap">
                      {clipTopOfLive(streamThink, liveBase === 0 && msgSlice.length === 0 ? startPad : 0)}
                    </Text>
                  )}
                  {streamThink && streamText && <Box height={1} />}
                  {streamText && (
                    <StreamingBlock text={clipTopOfLive(streamText, liveBase === 0 && msgSlice.length === 0 ? startPad : 0)} t={t} width={mdWidth} cursorOn={cursorOn} />
                  )}
                </Box>
              )}
            </Box>
          )}
          {fillerRows > 0 && <Box height={fillerRows} />}
        </Box>

        {diagOpen && <DiagTray lines={diag} t={t} width={mdW} />}
        {confirmReq && (
          <Box flexDirection="column" width="100%" marginTop={1} borderStyle="single" borderColor={t.warn} paddingX={1} paddingY={1}>
            {/* ⚠ + 空格 + "危险命令: " = 8 列; 超宽换行会让确认框 +1 行 → 帧高漂移 */}
            <Text color={t.warn} bold wrap="wrap">
              {truncateTo(`⚠ 危险命令: ${confirmReq.hint}`, Math.max(10, panelW))}
            </Text>
            <Text color={t.ink} wrap="wrap">
              {truncateTo(confirmReq.cmd, Math.max(10, panelW))}
            </Text>
            <Text color={t.inkFaint} wrap="wrap">
              [y] 执行一次 · [a] 本会话允许 · [Esc] 取消
            </Text>
          </Box>
        )}
        {paletteOpen && (
          <PalettePanel
            phase={palettePhase}
            mode={paletteMode}
            rows={palettePhase === "commands" ? rankCommands(paletteQuery, mruRef.current).map((c) => ({ group: c.group, cmd: c.name, desc: c.desc, shortcut: c.shortcut })) : []}
            sessions={paletteSessionsRef.current}
            archivedScope={paletteScopedRef.current === "archived"}
            query={paletteQuery}
            sel={paletteSel}
            t={t}
          />
        )}
        {previewOpen && (
          <Box flexDirection="column" width="100%" marginTop={1} borderStyle="single" borderColor={t.inkFaint} paddingX={1} paddingY={1}>
            {/* 头文字与提示合并为单行(显示宽截断): 双色用嵌套 Text, 不靠 row Box */
            /* 换行会让帧高+1 → 帧超终端滚动 → 光标错位。标题 5 个 CJK = 10 列宽 */}
            <Text>
              <Text color={t.ok} bold>长输入预览 </Text>
              <Text color={t.inkFaint}>{truncateTo(`　输入已较长, 完整内容在此查看 · Enter 确认发送 · Esc 收起继续编辑`, Math.max(10, panelW - 11))}</Text>
            </Text>
            <Text color={t.ink} wrap="wrap">
              {clipTextRowsKeep(input, Math.min(previewLines, PREVIEW_LINES), panelW)}
            </Text>
          </Box>
        )}
        {settingsOpen ? (
          <SettingsPanel draft={configDraft} field={configField} t={t} providerName={activeProvider()} onChange={(key, value) => setConfigDraft((d) => ({ ...d, [key]: value }))} />
        ) : (
          <Box flexDirection="column" width="100%" marginTop={1}>
            <Box flexDirection="row">
              <Text color={t.accent} bold>
                {mode === "shell" ? "$ " : "> "}
              </Text>
              <Input
                value={input}
                focus
                t={t}
                // base = paddingX(2) + prompt 内容宽 + 首列 1 基:
                // prompt 一律用宽度恒为 1 的字符(">"/"$" 类), 禁用 ❯/▸ 等
                // East Asian Ambiguous 字形 —— CJK 终端会把它们渲染成 2 列,
                // 导致 IME 光标整行左偏"正好一个宽度"。
                realCaret={{ base: 2 + displayWidth(mode === "shell" ? "$ " : "> ") + 1 }}
                wrap={mdW}
                maxRows={INPUT_MAX_ROWS}
                inputTop={inputTop}
                absSafe={chromeRows <= rows}
                placeholder={placeholder}
                onChange={setInput}
                onSubmit={submit}
              />
              <Box flexGrow={1} />
              <Text color={t.inkFaint}>{mode === "shell" ? "[shell]" : ""}</Text>
            </Box>
          </Box>
        )}
        {statuslineOn && <StatusLine t={t} model={modelName} sessionId={sessionIdRef.current} sinceMs={sessionStartRef.current} width={mdWidth} />}
      </Box>
    </AppErrorBoundary>
  )
}
// ---------- 头部 ----------

function Header({ t, cwd, model, width }: { t: ThemeTokens; cwd: string; model: string; width: number }): ReactNode {
  const dir = basename(cwd) || cwd
  // 单行封顶(按显示宽截断): 头部任何一行换行都会让整帧高 +1 → 终端滚动 → 光标错位
  const dirFit = truncateTo(dir, Math.max(6, Math.floor(width / 2)))
  const modelFit = truncateTo(model, Math.max(8, width - 16 - Math.floor(width / 2)))
  return (
    <Box flexDirection="row" borderStyle="single" borderTop={false} borderBottom borderRight={false} borderLeft={false} borderColor={t.inkFaint} paddingBottom={1} marginBottom={1}>
      <Text color={t.accent} bold>
        ●{" "}
      </Text>
      <Text bold color={t.ink}>
        minicode
      </Text>
      <Text color={t.inkFaint}> {dirFit}</Text>
      <Box flexGrow={1} />
      <Text color={t.inkFaint}>{modelFit}</Text>
    </Box>
  )
}

// ---------- 内容层消息块 ----------

function timeStr(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** 会话列表的相对时间(短格式, 避免挤爆面板行) */
function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const dt = new Date(ts)
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`
}

function clipMsgText(text: string, w: number, clipTop: number): string {
  return clipTop > 0 ? clipTextRows(text, clipTop, w) : text
}

const MsgBlock = React.memo(function MsgBlock({
  msg,
  t,
  width,
  clipTop,
  thinkOpen,
}: {
  msg: ChatMsg
  t: ThemeTokens
  width: number
  clipTop?: number
  /** 思考过程展开态(仅 assistant 且有 think 时生效) */
  thinkOpen?: boolean
}): ReactNode {
  switch (msg.kind) {
    case "user": {
      // 我的消息: 右对齐, 无背景填充, 右侧 accent 边条与 AI 回答的左侧边条呼应
      const bw = bubbleWidth(msg.text, width)
      return (
        <Box
          flexDirection="column"
          width="100%"
          alignItems="flex-end"
          borderStyle="single"
          borderRight
          borderLeft={false}
          borderTop={false}
          borderBottom={false}
          borderColor={t.accentDim}
        >
          <Box flexDirection="row" paddingRight={1}>
            <Text color={t.inkDim} bold>
              你
            </Text>
            <Text color={t.inkFaint}> {timeStr(msg.ts)}</Text>
          </Box>
          <Box width={bw} paddingLeft={1} paddingRight={1}>
            <Text color={t.ink} wrap={bw >= width ? "wrap" : undefined}>
              {clipMsgText(msg.text, Math.max(2, bw - 2), Math.max(0, clipTop ? clipTop - 1 : 0))}
            </Text>
          </Box>
        </Box>
      )
    }
    case "assistant": {
      const w = Math.max(1, width - 2)
      const think = msg.think
      const open = thinkOpen && !!think
      const c = Math.max(0, clipTop ?? 0)
      // 思考块在气泡内容顶部: 标题行被裁(或整体被裁)时按行跳过
      const thinkClip = c === 0 ? 0 : c - 1
      const thinkH = open && think ? estimateMarkdownHeight(think, w) : 0
      const answerClip = Math.max(0, c - 1 - (open && think ? thinkH : 0))
      return (
        <Box
          flexDirection="column"
          width="100%"
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={t.accentDim}
          paddingLeft={1}
        >
          {think && thinkClip === 0 && (
            <Box flexDirection="row">
              <Text color={t.accentDim} bold>
                {open ? "▾" : "▸"} 思考过程
              </Text>
              <Text color={t.inkDim}> · 点击/Ctrl+t {open ? "折叠" : "展开"}</Text>
            </Box>
          )}
          {open && think && (
            <Text color={t.inkDim} wrap="wrap">
              {clipMsgText(think, w, thinkClip)}
            </Text>
          )}
          {renderMarkdown(clipMsgText(msg.text, w, answerClip), t, w)}
        </Box>
      )
    }
    case "verdict":
    case "danger":
    case "info": {
      const detail = msg.detail ?? []
      let detailArr = detail
      let text = msg.text
      if (clipTop && clipTop >= 1) {
        detailArr = detail.slice(clipTop - 1)
        text = ""
      }
      return (
        <Box flexDirection="column" width="100%">
          <Text wrap="wrap">
            {text && (
              <Text color={msg.kind === "verdict" ? (msg.ok ? t.ok : t.err) : msg.kind === "danger" ? t.err : undefined} bold={msg.kind !== "info"}>
                {msg.kind === "verdict" ? (msg.ok ? "✓ " : "✗ ") : msg.kind === "danger" ? "✗ " : ""}
                {text}
              </Text>
            )}
          </Text>
          {detailArr.map((d, i) => (
            <Text key={i} color={t.inkFaint} wrap="wrap">
              {d}
            </Text>
          ))}
        </Box>
      )
    }
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

function DiagTray({ lines, t, width }: { lines: DiagLine[]; t: ThemeTokens; width: number }): ReactNode {
  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Text color={t.inkDim}>诊断(最近 {lines.length} 条):</Text>
      {lines.slice(-8).map((d, i) => (
        <Text key={i} color={d.level === "err" ? t.err : d.level === "warn" ? t.ok : t.inkFaint} wrap="wrap">
          [{timeStr(d.ts)}] {truncateTo(d.text, Math.max(10, width - 18))}
        </Text>
      ))}
    </Box>
  )
}
