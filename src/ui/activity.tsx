// 活动面板 —— 运行时的波次/节点可视化(A1: 活动信息独立于对话内容)
// 运行时展开(右侧 40%), 完成后由 App 收回; 支持焦点选择/展开查看细节。
// 数据: useActivity hook 把 runDual/runPlan/runVBuild 三类运行事件统一桥接成
//       一棵任务树 + 流式输出缓冲, 渲染层与业务层完全解耦。

import React, { useMemo, useReducer, useRef } from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { TaskNode } from "../types.ts"
import { upsertWave, updateTool, markWave } from "./tree.tsx"
import type { ThemeTokens } from "./theme.ts"
import { computeWindow, estimateMarkdownHeight } from "./viewport.tsx"

export type ActivityPhase = "idle" | "decompose" | "run" | "plan"

export interface ActivityState {
  tree: TaskNode | null
  phase: ActivityPhase
  /** 拆解阶段 LLM 流式输出的尾部(实时显示) */
  decomposeNote: string
  /** Plan 模式: 生成好的计划骨架(renderSpec 行) */
  planLines: string[]
  /** 当前运行中的工具数 */
  running: number
  /** 节点 key → 流式输出尾部(展开查看/过程 feed) */
  streams: Map<string, string>
  /** 节点 key → 结果摘要 */
  summaries: Map<string, string>
  /** 波次 n → 开始时间(进度条用) */
  waveStartAt: Map<number, number>
}

export interface ActivityAPI {
  state: ActivityState
  begin(label: string): void
  setPhase(p: ActivityPhase): void
  end(): void
  decompose(text: string): void
  /** Plan 模式: 计划生成完毕, 展示骨架(不执行) */
  setPlan(lines: string[]): void
  waveStart(n: number, parallel: boolean, calls?: Array<{ id: string; tool: string }>): void
  nodeStart(id: string, tool: string): void
  nodeResult(id: string, tool: string, ms: number, error?: string, summary?: string): void
  nodeStream(key: string, text: string): void
  waveEnd(n: number): void
}

export function useActivity(): ActivityAPI {
  const [, force] = useReducer((x: number) => x + 1, 0)
  const s = useRef<ActivityState>({
    tree: null,
    phase: "idle",
    decomposeNote: "",
    planLines: [],
    running: 0,
    streams: new Map(),
    summaries: new Map(),
    waveStartAt: new Map(),
  })
  // 帧级合并渲染: 流式/节点事件高频到达, 全部合并到 16ms 帧内一次重绘。
  // 这是流式(协程级逐 delta 产出)与渲染(帧)的调和点 —— 一帧一次 setState。
  const frameRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedule = useRef<(fn: () => void) => void>(() => {})
  schedule.current = (fn: () => void) => {
    if (frameRef.current) return
    frameRef.current = setTimeout(() => {
      frameRef.current = null
      fn()
    }, 16)
  }
  const api = useMemo<ActivityAPI>(() => {
    const st = (): ActivityState => s.current
    const touch = (): void => schedule.current(() => force())
    return {
      get state() {
        return s.current
      },
      begin(label) {
        const a = s.current
        a.tree = { id: `run_${Date.now()}`, label, status: "running", children: [] }
        a.phase = "decompose"
        a.decomposeNote = ""
        a.planLines = []
        a.running = 0
        a.streams.clear()
        a.summaries.clear()
        a.waveStartAt.clear()
        touch()
      },
      setPhase(p) {
        s.current.phase = p
        touch()
      },
      end() {
        s.current.tree = null
        s.current.phase = "idle"
        s.current.decomposeNote = ""
        s.current.running = 0
        touch()
      },
      decompose(text) {
        s.current.decomposeNote = (s.current.decomposeNote + text).slice(-600)
        touch()
      },
      setPlan(lines) {
        const a = s.current
        a.phase = "plan"
        a.planLines = lines
        touch()
      },
      waveStart(n, parallel, calls) {
        s.current.waveStartAt.set(n, Date.now())
        if (s.current.tree) {
          upsertWave(s.current.tree, {
            n,
            parallel,
            calls: (calls ?? []).map((c) => ({ id: c.id, tool: c.tool, args: {} })),
          })
        }
        touch()
      },
      nodeStart(id, tool) {
        s.current.running++
        if (s.current.tree) {
          const waves = s.current.tree.children
          let w = waves[waves.length - 1]
          if (!w || !w.id.startsWith("wave_")) {
            w = {
              id: `wave_${Date.now()}`,
              label: "波次",
              status: "running",
              children: [],
            }
            s.current.tree.children.push(w)
          }
          if (!w.children.some((c) => c.id === id)) {
            w.children.push({ id, label: tool, status: "running", children: [] })
          } else {
            updateTool(s.current.tree, { id, tool, status: "running" })
          }
        }
        touch()
      },
      nodeResult(id, tool, ms, error, summary) {
        s.current.running = Math.max(0, s.current.running - 1)
        if (summary) s.current.summaries.set(id, summary)
        if (s.current.tree) {
          for (const w of s.current.tree.children) {
            const n = w.children.find((c) => c.id === id)
            if (!n) continue
            n.status = error ? "error" : "done"
            n.ms = ms
            if (error) n.error = error
            if (w.children.length && w.children.every((c) => c.status !== "running")) w.status = "done"
            break
          }
        }
        touch()
      },
      nodeStream(key, text) {
        const a = s.current
        a.streams.set(key, ((a.streams.get(key) ?? "") + text).slice(-2000))
        if (a.tree) {
          for (const w of a.tree.children) {
            const n = w.children.find((c) => c.id === key)
            if (n) {
              n.note = ((n.note ?? "") + text).slice(-160)
              break
            }
          }
        }
        touch()
      },
      waveEnd(n) {
        if (s.current.tree) markWave(s.current.tree, n, "done")
        touch()
      },
    }
  }, [])
  return api
}

// ---------- 渲染 ----------

interface FlatNode {
  wave: TaskNode
  node: TaskNode
}

/** 面板布局计算(渲染与鼠标命中检测共用): 波次头/节点行/展开内容 → 行高表 + 块表 + 视口窗口 */
export function computePanelLayout(
  state: ActivityState,
  opts: { expanded: Set<string>; width: number; rows: number; focused: boolean; sel: number },
): {
  blocks: Array<{ type: "wave"; w: TaskNode } | { type: "node"; w: TaskNode; n: TaskNode }>
  rowHeights: number[]
  start: number
  startPad: number
  end: number
} {
  const tree = state.tree
  const waves = (tree?.children ?? []).filter((w) => w.id.startsWith("wave_"))
  const contentW = Math.max(10, opts.width - 4)
  const rowHeights: number[] = []
  const blocks: Array<{ type: "wave"; w: TaskNode } | { type: "node"; w: TaskNode; n: TaskNode }> = []
  for (const w of waves) {
    rowHeights.push(1)
    blocks.push({ type: "wave", w })
    for (const n of w.children) {
      let h = 1
      const st = state.streams.get(n.id)
      const sum = state.summaries.get(n.id)
      if (opts.expanded.has(n.id) || n.status === "running") {
        if (n.error) h += estimateMarkdownHeight(n.error, contentW)
        if (sum) h += estimateMarkdownHeight(sum, contentW)
        if (st) h += estimateMarkdownHeight(st.slice(-240), contentW)
      }
      if (n.status === "running" && st) h += estimateMarkdownHeight(st.slice(-240), contentW)
      rowHeights.push(h)
      blocks.push({ type: "node", w, n })
    }
  }
  let off: number
  if (opts.focused && opts.sel >= 0) {
    // 焦点模式: 窗口中心对准选中节点
    let acc = 0
    let i = 0
    for (; i <= opts.sel && i < blocks.length; i++) acc += rowHeights[i]!
    off = acc - opts.rows / 2
  } else {
    off = 1e9 // 贴底
  }
  const { start, startPad, end } = computeWindow(rowHeights, opts.rows, off)
  return { blocks, rowHeights, start, startPad, end }
}

/** 进度条: 实心 ▰ / 空心 ▱, fill ∈ [0,1] */
export function progressBar(fill: number, width = 6): string {
  const clamped = Math.max(0, Math.min(1, fill))
  const full = Math.round(clamped * width)
  return "▰".repeat(full) + "▱".repeat(width - full)
}

function WaveHeader({ wave, t, now }: { wave: TaskNode; t: ThemeTokens; now: number }): ReactNode {
  const num = wave.id.replace("wave_", "")
  const parallel = wave.children.length > 1
  const doneCount = wave.children.filter((c) => c.status === "done" || c.status === "error").length
  let label: string
  let color: string | undefined
  let bar: string | undefined
  if (wave.status === "running") {
    label = `${parallel ? "⚡" : "→"} 波次 ${num}${parallel ? ` · ${wave.children.length} 并行` : ""}`
    color = t.accent
  } else if (wave.status === "done") {
    label = `✓ 波次 ${num} (${doneCount}/${wave.children.length})`
    color = t.inkDim
  } else {
    label = `○ 波次 ${num}`
    color = t.inkFaint
  }
  return (
    <Text color={color}>
      {label}
      {wave.status === "running" && bar}
    </Text>
  )
}

export const NODE_GLYPH: Record<TaskNode["status"], { char: string; color: keyof ThemeTokens }> = {
  pending: { char: "○", color: "inkFaint" },
  running: { char: "◐", color: "accent" },
  done: { char: "✓", color: "ok" },
  error: { char: "✗", color: "err" },
}

function NodeRow({
  node,
  t,
  selected,
  expanded,
  stream,
  summary,
  now,
  waveStartAt,
}: {
  node: TaskNode
  t: ThemeTokens
  selected: boolean
  expanded: boolean
  stream?: string
  summary?: string
  now: number
  waveStartAt?: number
}): ReactNode {
  const g = NODE_GLYPH[node.status]
  // 面板体积小 → 只显示简洁信息: 工具名 + 进度条 + 耗时 + 错误(截断)。
  // 参数/流式输出不进行内(左侧对话流已承载计划骨架与内容, 右侧只做执行状态)。
  const ms = node.ms !== undefined ? ` ${node.ms.toFixed(0)}ms` : ""
  // 运行中节点: 实时进度条(1.5s 走满) + 已用时长 —— 并行执行"看得见在动"
  const elapsed = node.status === "running" && waveStartAt !== undefined ? (now - waveStartAt) / 1000 : undefined
  const bar = node.status === "running" ? ` ${progressBar(elapsed !== undefined ? elapsed / 1.5 : 0.2, 6)}` : ""
  const elapsedTxt = elapsed !== undefined ? ` ${elapsed.toFixed(1)}s` : ""
  return (
    <Box flexDirection="column" width="100%">
      <Text color={selected ? t.accent : t[g.color]} bold={selected} wrap="wrap">
        {selected ? "▸ " : "  "}
        {g.char} {node.label}
        <Text color={t.accent}>{bar}</Text>
        <Text color={t.inkFaint}>{ms || elapsedTxt}</Text>
        {node.error ? <Text color={t.err}> — {node.error.slice(0, 48)}</Text> : null}
      </Text>
      {/* 默认展开: 运行中节点始终显示流式内容(执行过程默认可见); 点击可收起 */}
      {(expanded || node.status === "running") && (stream || summary || node.error) && (
        <Box flexDirection="column" paddingLeft={3} width="100%">
          {node.error && (
            <Text color={t.err} wrap="wrap">
              ✗ {node.error}
            </Text>
          )}
          {summary && (
            <Text color={t.inkDim} wrap="wrap">
              {summary}
            </Text>
          )}
          {stream && (
            <Text color={t.inkFaint} wrap="wrap">
              {stream.slice(-240)}
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}

export function ActivityPanel({
  state,
  t,
  focused,
  sel,
  expanded,
  now = Date.now(),
  width = 40,
  rows = 20,
}: {
  state: ActivityState
  t: ThemeTokens
  focused: boolean
  sel: number
  expanded: Set<string>
  now?: number
  width?: number
  rows?: number
}): ReactNode {
  const tree = state.tree
  if (!tree) return null
  const waves = tree.children.filter((w) => w.id.startsWith("wave_"))
  const flat: FlatNode[] = []
  for (const w of waves) for (const n of w.children) flat.push({ wave: w, node: n })

  if (state.phase === "decompose") {
    return (
      <Box flexDirection="column" width="100%">
        <Text color={t.inkDim}>声明中…</Text>
        {state.decomposeNote && (
          <Text color={t.inkDim} dimColor wrap="wrap">
            {state.decomposeNote}
            {state.decomposeNote.length >= 600 ? "…" : ""}
          </Text>
        )}
      </Box>
    )
  }
  if (state.phase === "plan") {
    return (
      <Box flexDirection="column" width="100%">
        <Text color={t.inkDim}>计划(Plan 模式 · 不执行)</Text>
        {state.planLines.map((l, i) => (
          <Text key={i} color={t.inkFaint} wrap="wrap">
            ○ {l}
          </Text>
        ))}
      </Box>
    )
  }
  if (waves.length === 0) {
    return (
      <Box flexDirection="column" width="100%">
        <Text color={t.inkFaint}>运行中…</Text>
      </Box>
    )
  }
  // 面板内部虚拟滚动: 每块(wave 头/节点行/展开内容)估算高度, 只渲染视口窗口。
  // 焦点导航时窗口跟随选中节点(selection 不滚出视口)。
  const layout = computePanelLayout(state, { expanded, width, rows, focused, sel })
  const slice = layout.blocks.slice(layout.start, layout.end)
  return (
    <Box flexDirection="column" width="100%">
      {layout.startPad > 0 && <Box height={layout.startPad} />}
      {slice.map((b) => {
        if (b.type === "wave") {
          return <WaveHeader key={b.w.id} wave={b.w} t={t} now={now} />
        }
        const n = b.n
        const w = b.w
        const waveStartAt = state.waveStartAt.get(Number(w.id.replace("wave_", "")))
        const idx = flat.findIndex((f) => f.node.id === n.id)
        return (
          <NodeRow
            key={n.id}
            node={n}
            t={t}
            selected={focused && idx === sel}
            expanded={expanded.has(n.id)}
            stream={state.streams.get(n.id)}
            summary={state.summaries.get(n.id)}
            now={now}
            waveStartAt={waveStartAt}
          />
        )
      })}
    </Box>
  )
}
