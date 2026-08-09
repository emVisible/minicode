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
import { saveConfig, loadConfig, applyConfigToEnv, configPath } from "../config.ts"
import { log, logPath, logTail } from "../log.ts"
import { saveSession, listSessions, loadSession, newSessionId, latestSession, sessionsDirPath } from "../session.ts"
import { copyToClipboard } from "../clipboard.ts"
import { SettingsPanel } from "./settings.tsx"
import { Input } from "./input.tsx"
import { renderMarkdown, displayWidth } from "./markdown.tsx"
import { WelcomeCard } from "./welcome.tsx"
import { tokens, initialThemeName } from "./theme.ts"
import type { ThemeTokens, ThemeName } from "./theme.ts"
import type { MinicodeConfig } from "../config.ts"
import type { ChatMsg, DiagLine } from "../types.ts"
import { useTerminalSize, estimateMsgHeight, estimateMarkdownHeight, computeWindow, totalHeight, clampOffset, clipTextRows, clipTextRowsKeep, bubbleWidth } from "./viewport.tsx"
import { COMMANDS, LEADER_KEYS, LEADER_TIMEOUT_MS, matchCommands, helpLines, transcriptName } from "../commands.ts"

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
  const pendingSessionsRef = useRef<Array<{ id: string; label: string }> | null>(null)

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
  const scrollRef = useRef({ offset: 0, lock: true })
  scrollRef.current = { offset: scrollOffset, lock: scrollLock }
  const metricsRef = useRef({ viewportRows: 20, heights: [] as number[] })
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
  const typeRef = useRef({ target: "", shown: 0 })
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  function saveConfigPanel(): void {
    const cfg: MinicodeConfig = {
      llmUrl: configDraft.llmUrl?.trim() || undefined,
      llmApiKey: configDraft.llmApiKey?.trim() || undefined,
      llmModel: configDraft.llmModel?.trim() || undefined,
    }
    saveConfig(cfg)
    // 直接覆写进程内 env: applyConfigToEnv 只在 env 未设置时填充,
    // 启动时已注入旧值 → 面板保存后必须强制更新, 否则"输入无效"
    if (cfg.llmUrl) process.env.LLM_URL = cfg.llmUrl
    if (cfg.llmApiKey) process.env.LLM_API_KEY = cfg.llmApiKey
    if (cfg.llmModel) process.env.LLM_MODEL = cfg.llmModel
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
    pushMsg({ kind: "user", text: display, ts: Date.now() })
    log.info("tui", "消息开始", { prompt: prompt.slice(0, 120) })
    historyRef.current = [...historyRef.current, { role: "user", content: prompt }]
    const messages: import("../types.ts").ChatMessage[] = [
      { role: "system", content: system },
      ...historyRef.current,
    ]

    try {
      const result = await client.stream({
        messages,
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type !== "text-delta") return
          pushType(e.text)
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
      if (result.finish === "aborted") {
        pushMsg({ kind: "danger", text: "已中断", ts: Date.now() })
      } else if (result.finish === "length" || result.finish === "content_filter" || result.finish === "error") {
        pushMsg({ kind: "danger", text: `回答被截断/终止 (finish=${result.finish})`, ts: Date.now() })
      } else {
        pushMsg({ kind: "verdict", ok: true, text: "完成", ts: Date.now() })
      }
    } catch (e) {
      if (!controller.signal.aborted) pushMsg({ kind: "danger", text: e instanceof Error ? e.message : String(e), ts: Date.now() })
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

  function submit(value: string): void {
    const trimmed = value.trim()
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
    if (!trimmed) return
    if (busy) {
      pushMsg({ kind: "info", text: "上一轮仍在运行, 按 Esc / Ctrl+C 中断后再输入", ts: Date.now() })
      return
    }
    if (mode === "shell") {
      setInput("")
      void runShell(trimmed)
      return
    }
    if (trimmed === "/quit" || trimmed === "/exit") {
      flushSession.current()
      exit()
      return
    }
    if (trimmed === "/log") {
      pushMsg({ kind: "info", text: `日志文件: ${logPath()}`, detail: logTail(40), ts: Date.now() })
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
      pushMsg({ kind: "info", text: "会话列表(输入序号恢复, 如 1):", detail, ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/sessions_dir" || trimmed === "/sdir") {
      pushMsg({ kind: "info", text: `会话目录: ${sessionsDirPath()}`, ts: Date.now() })
      setInput("")
      return
    }
    if (trimmed === "/reset" || trimmed === "/new" || trimmed === "/clear") {
      flushSession.current()
      historyRef.current = []
      setMsgs([])
      setDiag([])
      sessionIdRef.current = newSessionId(cwd)
      scrollToBottom()
      setInput("")
      pushMsg({ kind: "info", text: `已保存当前会话并开始新会话 (${sessionIdRef.current})`, ts: Date.now() })
      return
    }
    if (trimmed === "/help") {
      pushMsg({
        kind: "info",
        text: "命令列表(ctrl+x + 字母为快捷键 · Tab 切换 对话/命令行 模式):",
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

  // ---------- 领衔快捷键(ctrl+x + 字母) ----------
  const leaderRef = useRef<{ target: string | null; timer: ReturnType<typeof setTimeout> | null }>({ target: null, timer: null })
  const [leaderHint, setLeaderHint] = useState<string | null>(null)

  function dispatchLeader(action: string): void {
    const actions: Record<string, () => void> = {
      new: () => {
        flushSession.current()
        historyRef.current = []
        setMsgs([])
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
        pushMsg({ kind: "info", text: "会话列表(输入序号恢复, 如 1):", detail, ts: Date.now() })
      },
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
      export: () => void exportTranscript(),
      editor: () => void composeInEditor(),
      copy: () => {
        // 复制最后一条 assistant 回答(可能跨多次回答取最后一条)
        const last = [...msgs].reverse().find((m) => m.kind === "assistant")
        if (!last) {
          pushMsg({ kind: "info", text: "还没有助手回答可复制", ts: Date.now() })
          return
        }
        const r = copyToClipboard(last.text)
        pushMsg({ kind: r.ok ? "verdict" : "danger", ok: r.ok, text: r.msg, detail: [last.text.slice(0, 200)], ts: Date.now() })
      },
      copyq: () => {
        // 复制最近一条我发的问题
        const last = [...msgs].reverse().find((m) => m.kind === "user")
        if (!last) {
          pushMsg({ kind: "info", text: "还没有可复制的问题", ts: Date.now() })
          return
        }
        const r = copyToClipboard(last.text)
        if (!r.ok) {
          pushMsg({ kind: "danger", text: r.msg, ts: Date.now() })
        } else {
          pushMsg({ kind: "verdict", ok: true, text: r.msg, detail: [last.text.slice(0, 200)], ts: Date.now() })
        }
      },
      diag: () => setDiagOpen((v) => !v),
      help: () => pushMsg({ kind: "info", text: "命令列表(ctrl+x + 字母为快捷键 · Tab 补全 / 命令):", detail: helpLines(), ts: Date.now() }),
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
    setLeaderHint(null)
  }
  function armLeader(): void {
    const l = leaderRef.current
    if (l.timer) clearTimeout(l.timer)
    l.target = "armed"
    l.timer = setTimeout(clearLeader, LEADER_TIMEOUT_MS)
    setLeaderHint("ctrl+x + 字母: n新 l会话 t主题 g间距 m模型 e编辑器 c复制回答 v复制问题 x导出 d诊断 ?帮助 q退出 · Tab 切换命令行")
  }
  function exitConfirmed(): void {
    flushSession.current()
    exit()
  }

  useInput((ch, key) => {
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
      // Tab: 切换 对话模式 ↔ 命令行模式(不再用于 / 补全; 设置面板内 Tab 仍切换字段)
      if (busy) {
        pushMsg({ kind: "info", text: "运行中无法切换模式, 按 Esc 中断后重试", ts: Date.now() })
        return true
      }
      setMode((m) => (m === "chat" ? "shell" : "chat"))
      pushMsg({ kind: "info", text: mode === "chat" ? "已切换到命令行模式: 输入直接作为 shell 命令执行 (再按 Tab 切回对话)" : "已切换到对话模式 (再按 Tab 切命令行)", ts: Date.now() })
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
      pushMsg({ kind: "info", text: "命令面板(ctrl+x + 字母为快捷键 · Tab 切换 对话/命令行):", detail: helpLines(), ts: Date.now() })
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
      // Esc 只用于"取消": 关闭面板/取消当前操作/中断请求; 绝不退出(退出只走 Ctrl+C 双击)
      if (previewOpen) {
        setPreviewOpen(false)
        pushMsg({ kind: "info", text: "已收起长输入预览, 可继续编辑(Enter 再确认发送)", ts: Date.now() })
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
        setMode("chat")
      } else {
        pushMsg({ kind: "info", text: "按 Ctrl+C 两次退出 · Esc 仅用于取消", ts: Date.now() })
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
  // ---------- 视口度量 ----------
  const { cols, rows } = useTerminalSize(stdout)
  const mdWidth = Math.max(36, cols - 6)
  const cmdCandidates = !busy && input.startsWith("/") ? matchCommands(input) : []

  // 鼠标: 滚轮滚动消息区(自研 SGR 协议)
  const mouseCbRef = useRef<(e: import("./mouse.tsx").MouseEventData) => void>(() => {})
  mouseCbRef.current = (e) => {
    if (e.button === 64 || e.button === 65) {
      const dir = e.button === 64 ? -1 : 1
      const m = metricsRef.current
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
    }
  }
  useEffect(() => {
    return mouseBus?.on((e) => mouseCbRef.current(e))
  }, [mouseBus])

  const mdW = Math.max(1, mdWidth - 2)
  const previewLines = Math.min(PREVIEW_LINES, Math.max(1, Math.ceil(displayWidth(input) / mdW)))
  const chromeRows =
    2 + 4 + (settingsOpen ? 6 : 2) + 1 + (diagOpen ? 4 : 0) + Math.min(cmdCandidates.length, 4) + (previewOpen ? 3 + previewLines : 0) + (leaderHint ? 2 : 0) + 1
  const viewportRows = Math.max(8, rows - chromeRows)
  const heights = useMemo(() => msgs.map((m, i) => estimateMsgHeight(m, mdWidth) + (i === 0 || dense ? 0 : 1)), [msgs, mdWidth, dense])
  const segHeights = [...heights]
  let liveStream = false
  if (streamText) {
    liveStream = true
    segHeights.push(1 + estimateMarkdownHeight(streamText, mdW))
  }
  const docH = totalHeight(segHeights)
  const effectiveOffset = scrollLock ? Math.max(0, docH - viewportRows) : clampOffset(scrollOffset, viewportRows, segHeights)
  const win = computeWindow(segHeights, viewportRows, effectiveOffset)
  metricsRef.current = { viewportRows, heights: segHeights }
  const msgBase = heights.length
  const segStart = win.start
  const segEnd = win.end
  const startPad = win.startPad
  const visibleH = win.visibleH
  const msgSlice = msgs.slice(Math.min(segStart, msgBase), Math.min(segEnd, msgBase))
  const lastMsgInWindow = Math.min(segEnd, msgBase) - 1
  const liveBase = Math.max(0, segStart - msgBase)
  const liveEnd = Math.max(0, segEnd - msgBase)
  const fillerRows = Math.max(0, viewportRows - startPad - visibleH)
  const clipTopOfLive = (text: string, clip: number): string => (clip > 0 ? clipTextRows(text, clip, mdW) : text)
  const spinnerChar = "⠋⠙⠹⠸"[spinner] ?? " "

  return (
    <AppErrorBoundary onError={(e) => log.error("tui", "渲染错误", { message: e.message, stack: e.stack })}>
      <Box flexDirection="column" width="100%" paddingX={2} paddingTop={2} paddingBottom={0}>
        <Header t={t} cwd={cwd} model={modelName} />
        <Box flexDirection="column" width="100%" height={viewportRows} overflow="hidden">
          {msgs.length === 0 && <WelcomeCard cwd={cwd} model={modelName} t={t} />}
          {!scrollLock && effectiveOffset > 0 && (
            <Text color={t.inkFaint} dimColor wrap="wrap">
              ↑ 已滚动 {effectiveOffset} 行 · ↓ 回到底部
            </Text>
          )}
          {(msgSlice.length > 0 || liveEnd > liveBase) && (
            <Box flexDirection="column" width="100%">
              {msgSlice.map((m, i) => {
                const segIdx = segStart + i
                const clipTop = segIdx === segStart && segStart < msgBase ? startPad : 0
                const isLastMsgBlock = segIdx === lastMsgInWindow && lastMsgInWindow === segEnd - 1
                const clipBottom = isLastMsgBlock && win.endClip > 0 ? win.endClip : 0
                return <MsgBlock key={msgBase + i} msg={m} t={t} width={mdWidth} first={segIdx === 0} dense={dense} clipTop={clipTop} clipBottom={clipBottom} />
              })}
              {liveBase < liveEnd && liveStream && <StreamingBlock text={clipTopOfLive(streamText, liveBase === 0 ? startPad : 0)} t={t} width={mdWidth} cursorOn={cursorOn} />}
            </Box>
          )}
          {fillerRows > 0 && <Box height={fillerRows} />}
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
        {leaderHint && (
          <Box marginTop={1}>
            <Text color={t.accent} dimColor wrap="wrap">
              {leaderHint}
            </Text>
          </Box>
        )}
        {diagOpen && <DiagTray lines={diag} t={t} />}
        {previewOpen && (
          <Box flexDirection="column" width="100%" marginTop={1} borderStyle="single" borderColor={t.inkFaint} paddingX={1} paddingY={1}>
            <Box flexDirection="row">
              <Text color={t.ok} bold>
                长输入预览
              </Text>
              <Text color={t.inkFaint} wrap="wrap">
                　输入已较长, 完整内容在此查看 · Enter 确认发送 · Esc 收起继续编辑
              </Text>
            </Box>
            <Text color={t.ink} wrap="wrap">
              {clipTextRowsKeep(input, Math.min(previewLines, PREVIEW_LINES), mdW)}
            </Text>
          </Box>
        )}
        {settingsOpen ? (
          <SettingsPanel draft={configDraft} field={configField} t={t} onChange={(key, value) => setConfigDraft((d) => ({ ...d, [key]: value }))} />
        ) : (
          <Box flexDirection="column" width="100%" marginTop={1}>
            <Box flexDirection="row">
              <Text color={t.accent} bold>
                {mode === "shell" ? "$ " : "❯ "}
              </Text>
              <Input
                value={input}
                focus
                t={t}
                realCaret={{ base: 5, wrap: mdW }}
                placeholder={
                  busy
                    ? mode === "shell"
                      ? `执行中…(Esc 中断) ${spinnerChar}`
                      : `生成中…(Esc 中断) ${spinnerChar}${cps ? ` · ${cps}c/s` : ""}`
                    : mode === "shell"
                      ? "命令行模式: 输入 shell 命令, Enter 执行 · Tab 切回对话"
                      : "对话: 输入消息 (Ctrl+C 两次退出 · Tab 命令行 · Ctrl+o 配置 · 长输入自动预览)"
                }
                onChange={setInput}
                onSubmit={submit}
              />
              <Box flexGrow={1} />
              <Text color={t.inkFaint}>{mode === "shell" ? "[shell]" : ""}</Text>
            </Box>
          </Box>
        )}
      </Box>
    </AppErrorBoundary>
  )
}
// ---------- 头部 ----------

function Header({ t, cwd, model }: { t: ThemeTokens; cwd: string; model: string }): ReactNode {
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
      <Text color={t.inkFaint}>{model}</Text>
    </Box>
  )
}

// ---------- 内容层消息块 ----------

function timeStr(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function clipMsgText(text: string, w: number, clipTop: number, clipBottom: number): string {
  let out = clipTop > 0 ? clipTextRows(text, clipTop, w) : text
  if (clipBottom > 0) {
    const keep = Math.max(1, estimateMarkdownHeight(text, w) - clipBottom)
    out = clipTextRowsKeep(out, keep, w)
  }
  return out
}

const MsgBlock = React.memo(function MsgBlock({
  msg,
  t,
  width,
  first,
  dense,
  clipTop,
  clipBottom,
}: {
  msg: ChatMsg
  t: ThemeTokens
  width: number
  first: boolean
  dense?: boolean
  clipTop?: number
  clipBottom?: number
}): ReactNode {
  const gap = dense ? 0 : 1
  switch (msg.kind) {
    case "user": {
      // 我的消息: 右对齐气泡(聊天气泡式, 宽度随内容自适应, 不超 md 宽)
      const bw = bubbleWidth(msg.text, width)
      return (
        <Box flexDirection="column" width="100%" alignItems="flex-end" marginTop={first ? 0 : gap}>
          <Box flexDirection="row">
            <Text color={t.inkDim} bold>
              你
            </Text>
            <Text color={t.inkFaint}> {timeStr(msg.ts)}</Text>
          </Box>
          <Box backgroundColor={t.codeBg} width={bw} paddingLeft={1} paddingRight={1}>
            <Text color={t.ink} wrap={bw >= width ? "wrap" : undefined}>
              {clipMsgText(msg.text, Math.max(2, bw - 2), Math.max(0, clipTop ? clipTop - 1 : 0), clipBottom ?? 0)}
            </Text>
          </Box>
        </Box>
      )
    }
    case "assistant":
      return (
        <Box
          flexDirection="column"
          width="100%"
          marginTop={first ? 0 : gap}
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={t.accentDim}
          paddingLeft={1}
        >
          {renderMarkdown(clipMsgText(msg.text, Math.max(1, width - 2), Math.max(0, clipTop ? clipTop - 1 : 0), clipBottom ?? 0), t, width - 2)}
        </Box>
      )
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
      if (clipBottom && clipBottom >= 1 && detailArr.length > 0 && text.length === 0) {
        detailArr = detailArr.slice(0, Math.max(1, detailArr.length - clipBottom))
      }
      return (
        <Box flexDirection="column" width="100%" marginTop={1}>
          <Text wrap="wrap">
            <Text color={msg.kind === "verdict" ? (msg.ok ? t.ok : t.err) : msg.kind === "danger" ? t.err : undefined} bold={msg.kind !== "info"}>
              {msg.kind === "verdict" ? (msg.ok ? "✓" : "✗") : msg.kind === "danger" ? "✗" : ""}
              {text ? ` ${text}` : ""}
            </Text>
            {text && <Text color={t.inkDim}>{text}</Text>}
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

function DiagTray({ lines, t }: { lines: DiagLine[]; t: ThemeTokens }): ReactNode {
  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Text color={t.inkDim}>诊断(最近 {lines.length} 条):</Text>
      {lines.slice(-8).map((d, i) => (
        <Text key={i} color={d.level === "err" ? t.err : d.level === "warn" ? t.ok : t.inkFaint} wrap="wrap">
          [{timeStr(d.ts)}] {d.text.slice(0, 200)}
        </Text>
      ))}
    </Box>
  )
}
