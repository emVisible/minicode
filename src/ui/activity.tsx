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
  /** 节点 key → 流式输出尾部(展开查看) */
  streams: Map<string, string>
  /** 节点 key → 结果摘要 */
  summaries: Map<string, string>
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
  })
  const api = useMemo<ActivityAPI>(() => {
    const st = (): ActivityState => s.current
    const touch = (): void => force()
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
        s.current.decomposeNote = (s.current.decomposeNote + text).slice(-200)
        touch()
      },
      setPlan(lines) {
        const a = s.current
        a.phase = "plan"
        a.planLines = lines
        touch()
      },
      waveStart(n, parallel, calls) {
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
        a.streams.set(key, (a.streams.get(key) ?? "") + text)
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

function WaveHeader({ wave, t }: { wave: TaskNode; t: ThemeTokens }): ReactNode {
  const num = wave.id.replace("wave_", "")
  const parallel = wave.children.length > 1
  const doneCount = wave.children.filter((c) => c.status === "done" || c.status === "error").length
  let label: string
  let color: string | undefined
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
  return <Text color={color}>{label}</Text>
}

const NODE_GLYPH: Record<TaskNode["status"], { char: string; color: keyof ThemeTokens }> = {
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
}: {
  node: TaskNode
  t: ThemeTokens
  selected: boolean
  expanded: boolean
  stream?: string
  summary?: string
}): ReactNode {
  const g = NODE_GLYPH[node.status]
  const args = node.args && Object.keys(node.args).length ? ` ${JSON.stringify(node.args).slice(0, 48)}` : ""
  const ms = node.ms !== undefined ? ` ${node.ms.toFixed(0)}ms` : ""
  return (
    <Box flexDirection="column" width="100%">
      <Text color={selected ? t.accent : t[g.color]} bold={selected} wrap="wrap">
        {selected ? "▸ " : "  "}
        {g.char} {node.label}
        {args ? <Text color={t.inkDim}>{args}</Text> : null}
        <Text color={t.inkFaint}>{ms}</Text>
        {node.error ? <Text color={t.err}> — {node.error.slice(0, 80)}</Text> : null}
      </Text>
      {expanded && (stream || summary || node.error) && (
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
}: {
  state: ActivityState
  t: ThemeTokens
  focused: boolean
  sel: number
  expanded: Set<string>
}): ReactNode {
  const tree = state.tree
  if (!tree) return null
  const waves = tree.children.filter((w) => w.id.startsWith("wave_"))
  const flat: FlatNode[] = []
  for (const w of waves) for (const n of w.children) flat.push({ wave: w, node: n })

  if (state.phase === "decompose") {
    return (
      <Box flexDirection="column" width="100%">
        <Text color={t.inkDim}>拆解中…</Text>
        {state.decomposeNote && (
          <Text color={t.inkFaint} wrap="wrap">
            {state.decomposeNote}
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
  return (
    <Box flexDirection="column" width="100%">
      {waves.map((w) => (
        <Box key={w.id} flexDirection="column" width="100%">
          <WaveHeader wave={w} t={t} />
          {w.children.map((n) => {
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
              />
            )
          })}
        </Box>
      ))}
    </Box>
  )
}
