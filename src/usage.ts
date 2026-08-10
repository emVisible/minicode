// 用量账本 —— LLM 往返的 token / 耗时统计, 落盘到 <数据目录>/usage.json (按天 + 按会话聚合)。
// 数据源供 /usage(TUI 与 headless 共用)与未来的预算/熔断使用; 每次调用防抖 300ms 写入。

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homePath } from "./paths.ts"

export interface SessionUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  lastTs: number
}

interface DayUsage {
  turns: number
  inputTokens: number
  outputTokens: number
}

interface UsageStore {
  sessions: Record<string, SessionUsage>
  daily: Record<string, DayUsage>
}

let cache: UsageStore | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function usageFile(): string {
  return join(homePath(), "usage.json")
}

function load(): UsageStore {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(usageFile(), "utf8"))
    cache = { sessions: raw.sessions ?? {}, daily: raw.daily ?? {} }
  } catch {
    cache = { sessions: {}, daily: {} }
  }
  return cache
}

function persist(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    try {
      writeFileSync(usageFile(), JSON.stringify(load() ?? { sessions: {}, daily: {} }, null, 1), { mode: 0o600 })
    } catch {
      // 落盘失败不阻塞对话
    }
  }, 300)
}

/** 立即落盘(测试与退出路径用) */
export function flushUsage(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  try {
    writeFileSync(usageFile(), JSON.stringify(load() ?? { sessions: {}, daily: {} }, null, 1), { mode: 0o600 })
  } catch {
    // ignore
  }
}

export function usageDayKey(ts = Date.now()): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 记录一次 LLM 往返(成功/失败均记, 用量可能为 0) */
export function recordUsage(e: { ts?: number; sessionId: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number }): void {
  const ts = e.ts ?? Date.now()
  const s = load()
  const day = usageDayKey(ts)
  const acc = (a: SessionUsage): SessionUsage => ({
    turns: (a?.turns ?? 0) + 1,
    inputTokens: (a?.inputTokens ?? 0) + e.inputTokens,
    outputTokens: (a?.outputTokens ?? 0) + e.outputTokens,
    lastTs: ts,
  })
  s.sessions[e.sessionId] = acc(s.sessions[e.sessionId] ?? { turns: 0, inputTokens: 0, outputTokens: 0, lastTs: 0 })
  const d = s.daily[day] ?? { turns: 0, inputTokens: 0, outputTokens: 0 }
  s.daily[day] = { turns: d.turns + 1, inputTokens: d.inputTokens + e.inputTokens, outputTokens: d.outputTokens + e.outputTokens }
  persist()
}

/** 某会话的累计用量 */
export function sessionUsage(sessionId: string): SessionUsage | undefined {
  return load().sessions[sessionId]
}

/** 全局汇总: 今日 + 全部天数(最近在前的数组) */
export function usageSummary(): { today: DayUsage; days: Array<{ day: string; usage: DayUsage }> } {
  const s = load()
  const days = Object.entries(s.daily)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, usage]) => ({ day, usage }))
  return { today: s.daily[usageDayKey()] ?? { turns: 0, inputTokens: 0, outputTokens: 0 }, days }
}

/** 会话级用量在 /usage 的展示行 */
export function usageDetailLines(sessionId: string): string[] {
  const s = sessionUsage(sessionId)
  const { today, days } = usageSummary()
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const lines: string[] = []
  lines.push(
    s
      ? `本次会话: ${s.turns} 轮 · 输入 ${fmt(s.inputTokens)} · 输出 ${fmt(s.outputTokens)}`
      : "本次会话: 尚无 LLM 调用(命令行模式不计入)",
  )
  lines.push(`今日: ${today.turns} 轮 · 输入 ${fmt(today.inputTokens)} · 输出 ${fmt(today.outputTokens)}`)
  const recent = days.length ? `${days[0]!.day} · ${fmt(days[0]!.usage.inputTokens + days[0]!.usage.outputTokens)} tokens` : "无记录"
  lines.push(`累计: ${recent}`)
  return lines
}