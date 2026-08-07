// Influx 运行时 —— mini-react 架构语义移植:
//   render(计划→fiber 任务树) → reconcile(与上一轮快照 diff: placement/update/skip)
//   → commit(就绪前沿并行执行工具, 统一提交结果) → 重规划(计划随状态重渲染, 直到稳定)

import { createHash } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import { cpus } from "node:os"
import { log } from "../log.ts"

/** 默认并发上限: 利用一切可用硬件资源, 但避免 shell/LLM 争抢打满 */
export const DEFAULT_MAX_CONCURRENT = Math.max(1, Math.min(8, cpus().length))

export interface Element {
  type: unknown
  props: Record<string, any>
}

// JSX factory: 计划文件顶部 /** @jsx task */
export function task(type: unknown, props: Record<string, any> = {}, ...children: unknown[]): Element {
  return { type, props: { ...props, children: children.filter(Boolean) } }
}

export function Fragment(props: { children?: unknown }): unknown {
  return props.children
}

// 宿主任务标记: <Task tool="http.get" key="a" url="..." />
export function Task(_props: any): never {
  throw new Error("[influx] <Task> 是宿主标记, 不应被直接调用")
}

// 通用流程组件: <Flow key="demo">...</Flow>
export function Flow(props: any): any {
  return props.children
}

// JSON 计划说明(spec) → 与 JSX 相同的 Element 树, 供 agent 通过 MCP 直接下发计划
// spec 结构: { type?: "flow" | "task", key?, tool?, params?, dependsOn?, children?: spec[] }
export function planFromSpec(spec: any): unknown {
  if (spec === undefined || spec === null) return null
  if (Array.isArray(spec)) return spec.map(planFromSpec)
  if (typeof spec !== "object") throw new Error("[influx] spec 必须是对象或数组")
  const children = (spec.children ?? []).map(planFromSpec)
  if (spec.type === "task" || typeof spec.tool === "string") {
    if (!spec.tool) throw new Error("[influx] task 节点缺少 tool")
    return {
      type: Task,
      props: {
        ...(spec.params ?? {}),
        key: spec.key,
        tool: spec.tool,
        dependsOn: spec.dependsOn,
        when: spec.when,
        fallback: spec.fallback,
        retries: spec.retries,
        children,
      },
    }
  }
  return { type: Flow, props: { key: spec.key, dependsOn: spec.dependsOn, output: spec.output, children } }
}

export type ToolRun = (params: Record<string, any>, ctx: ToolCtx) => Promise<unknown>

/**
 * 预取缓存 —— 预测式执行: 计划 DAG 本身是"模型对自己后续行为的预测",
 * 在上一波执行期间预读下一波 read-file 的输入, 把 IO 延迟隐藏在波次执行后面。
 * warm() 是后台非阻塞的; get() 供 read-file 命中。
 */
export interface PrefetchCache {
  get(path: string): string | undefined
  warm(paths: string[]): void
  /** 文件被真实写入后作废旧缓存(防止预取内容过期) */
  invalidate(path: string): void
}

export interface ToolCtx {
  results: Record<string, unknown>
  errors: Record<string, string>
  /** 工作目录(代理给 agent 工具时使用) */
  cwd: string
  /** 写类/命令类工具的确认回调(计划侧默认放行, 由 CLI/MCP 注入) */
  ask: (req: { tool: string; summary: string }) => Promise<boolean>
  /** VBuild 虚拟文件系统: 存在时 write-file/read-file 走内存 overlay, RBuild 统一落盘 */
  vfs?: import("../vfs.ts").VFS
  /** llm 节点流式输出回调(thinking 过程可视化); key 为当前节点 key */
  onStream?: (key: string, text: string) => void
  /** 当前执行节点的 key(用于 llm 节点区分多个节点的流式输出) */
  key?: string
  /** 解析前的原始参数(模板 {$k.output} 未展开)。工具报错时可回看模型原始意图 */
  rawParams?: Record<string, any>
  /** 用户中断信号(Esc); 工具执行时合并到自身超时 */
  signal?: AbortSignal
  /** 预取缓存(预测式执行): read-file 命中后跳过磁盘 IO; 运行时预热下一前沿 */
  prefetch?: PrefetchCache
}

export type FiberStatus = "placement" | "update" | "skip" | "blocked"

export interface Fiber {
  key: string
  tool: string
  isHost: boolean
  params: Record<string, any>
  deps: string[]
  parent: Fiber | null
  child: Fiber | null
  sibling: Fiber | null
  done: boolean
  executed: boolean
  result: unknown
  fallback?: unknown
  retries?: number
  error?: unknown
  status: FiberStatus
  alt: Fiber | null
  ms: number
  /** Flow 的聚合输出模板(递归拆解: 子节点全部完成后, 解析引用并提交为父节点输出) */
  aggregate?: string
  aggregateCommitted?: boolean
}

export interface WaveNode {
  key: string
  tool: string
  ms: number
  status: string
  error?: string
  /** 节点结果的简短人类可读摘要(UI 展示用) */
  summary?: string
}

export interface WaveInfo {
  n: number
  parallel: boolean
  nodes: WaveNode[]
  ms: number
}

export interface RunStats {
  placed: number
  updated: number
  skipped: number
  blocked: number
  errors: number
}

export interface RunReport {
  waves: WaveInfo[]
  stats: RunStats
  /** 本次 run 缓存命中的节点 key(未实际执行) */
  cached: string[]
  /** 被级联阻断的节点 key → 原因(依赖失败/父节点阻断) */
  blocked: Record<string, string>
}

export interface PreviewNode {
  key: string
  tool: string
  verdict: "placement" | "update" | "skip"
  reason: string
}

export type RuntimeEvent =
  | { type: "iter"; n: number }
  | { type: "reconcile"; stats: RunStats }
  | { type: "wave-start"; n: number; parallel: boolean }
  | { type: "node-start"; key: string; tool: string; status: string }
  | { type: "node-end"; key: string; tool: string; status: string; ms: number; error?: string; summary?: string }
  | { type: "wave-end"; n: number; ms: number }
  | { type: "stream"; key: string; text: string }

export interface RuntimeOptions {
  serial?: boolean
  maxIter?: number
  /** 全局并发上限(同时执行的节点数); 默认 min(8, CPU 核数) */
  maxConcurrent?: number
  onEvent?: (e: RuntimeEvent) => void
  cwd?: string
  ask?: (req: { tool: string; summary: string }) => Promise<boolean>
  vfs?: import("../vfs.ts").VFS
  /** 预取缓存(预测式执行): 运行时在每波执行前预热下一就绪前沿的读输入 */
  prefetch?: PrefetchCache
  signal?: AbortSignal
}

// ---------- 调度器 ----------

export class Runtime {
  results: Record<string, unknown> = {}
  errors: Record<string, string> = {}
  blocked: Record<string, string> = {}
  lastTree: Fiber | null = null
  fiberInfo = new Map<string, { status: string; ms: number; executed: boolean }>()
  private prev = new Map<string, Fiber>()
  private waves: WaveInfo[] = []
  private stats: RunStats = { placed: 0, updated: 0, skipped: 0, blocked: 0, errors: 0 }
  private lastCached: string[] = []

  constructor(private getTool: (name: string) => ToolRun) {}

  // 计划函数通过 store 读取已提交的结果(含失败信息), 驱动下一轮重渲染
  get store() {
    return {
      get: (k: string) => this.results[k],
      errors: (k: string) => this.errors[k],
      blocked: (k: string) => this.blocked[k],
    }
  }

  async run(plan: unknown, opts: RuntimeOptions = {}): Promise<RunReport> {
    const { serial = false, maxIter = 8, maxConcurrent = DEFAULT_MAX_CONCURRENT, onEvent, cwd = process.cwd(), ask = async () => true, vfs, signal, prefetch } = opts
    this.waves = []
    this.stats = { placed: 0, updated: 0, skipped: 0, blocked: 0, errors: 0 }
    this.lastCached = []
    this.errors = {}
    this.blocked = {}
    const ctx: ToolCtx = {
      results: this.results,
      errors: this.errors,
      cwd,
      ask,
      ...(vfs ? { vfs } : {}),
      ...(signal ? { signal } : {}),
      ...(prefetch ? { prefetch } : {}),
      ...(onEvent
        ? {
            onStream: (key: string, text: string) => onEvent({ type: "stream", key, text }),
          }
        : {}),
    }
    // 静态计划(非函数)一次 render 即可收敛; 函数计划随状态重渲染直到稳定
    const maxLoop = typeof plan === "function" ? maxIter : 1

    log.info("influx", "计划执行开始", { plan: typeof plan === "function" ? "function" : "static", maxLoop })
    for (let i = 0; i < maxLoop; i++) {
      if (signal?.aborted) throw new Error("[influx] 计划执行已中断(用户取消)")
      onEvent?.({ type: "iter", n: i + 1 })
      const element = typeof plan === "function" ? (plan as any)(this.store) : plan
      this.lastTree = buildElement(element, null, ctx)
      const fibers = collect(this.lastTree)
      disambiguateKeys(fibers)
      const changed = this.reconcile(fibers)
      if (!changed) break
      onEvent?.({ type: "reconcile", stats: { ...this.stats } })
      await this.runWaves(fibers, serial, ctx, onEvent, maxConcurrent)
      for (const f of fibers) {
        if (!this.fiberInfo.has(f.key)) {
          this.fiberInfo.set(f.key, { status: f.status, ms: f.ms, executed: f.executed })
        }
      }
    }
    this.logRunSummary()
    return { waves: this.waves, stats: this.stats, cached: this.lastCached, blocked: this.blocked }
  }

  private logRunSummary(): void {
    log.info("influx", "计划执行结束", {
      waves: this.waves.length,
      stats: this.stats,
      blockedKeys: Object.keys(this.blocked),
    })
  }

  // 干跑预览: 不执行任何工具, 用与 run 相同的完整判定(含依赖传播)输出影响面
  async preview(plan: unknown): Promise<{ nodes: PreviewNode[] }> {
    const ctx: ToolCtx = {
      results: this.results,
      errors: this.errors,
      cwd: process.cwd(),
      ask: async () => true,
    }
    const element = typeof plan === "function" ? (plan as any)(this.store) : plan
    const tree = buildElement(element, null, ctx)
    const fibers = collect(tree)
    disambiguateKeys(fibers)
    const prevSnapshot = new Map(this.prev)
    judgeStatus(fibers, (k) => prevSnapshot.get(k))
    const reasons: Record<string, string> = {
      placement: "新节点, 需要执行",
      update: "参数或依赖变化, 需要重跑",
      skip: "参数未变, 结果已缓存",
    }
    const nodes: PreviewNode[] = []
    for (const f of fibers) {
      if (!f.isHost) continue
      // judgeStatus 只产生 placement/update/skip, blocked 是执行期语义
      nodes.push({
        key: f.key,
        tool: f.tool,
        verdict: f.status === "blocked" ? "skip" : (f.status as "placement" | "update" | "skip"),
        reason: reasons[f.status === "blocked" ? "skip" : f.status] ?? "",
      })
    }
    return { nodes }
  }

  private reconcile(fibers: Fiber[]): boolean {
    const next = new Map<string, Fiber>()
    for (const f of fibers) next.set(f.key, f)

    judgeStatus(fibers, (k) => this.prev.get(k))

    let changed = false
    for (const f of fibers) {
      if (f.status === "placement") {
        changed = true
        this.stats.placed++
      } else if (f.status === "update") {
        changed = true
        this.stats.updated++
      } else {
        const alt = this.prev.get(f.key)!
        f.done = true
        f.alt = alt
        if (alt.error !== undefined) {
          if (alt.fallback !== undefined) {
            // 上次失败但已用 fallback 提交到状态: 保持既有值
            f.result = this.results[f.key]
          } else if (alt.status === "blocked") {
            // 上次被级联阻断: 保持阻断状态
            this.blocked[f.key] = String(alt.error)
          } else {
            // 上次失败且无兜底: 保持错误状态, 继续阻断下游
            this.errors[f.key] = String(alt.error)
          }
        } else {
          f.result = alt.result
          this.results[f.key] = alt.result
        }
        this.stats.skipped++
        this.lastCached.push(f.key)
      }
    }
    this.prev = next
    return changed
  }

  private ready(f: Fiber): boolean {
    if (f.parent && !f.parent.done) return false
    return f.deps.every((d) => d in this.results)
  }

  /**
   * 预测式预取: 收集「当前波提交后就会就绪」的下一批 read-file/list-dir 输入路径。
   * 计划 DAG = 模型对自己后续行为的预测 —— 提前读, 把 IO 延迟隐藏在前一波执行背后。
   * 含 $ 引用(依赖先前结果)的路径无法现在就解析, 跳过; 写类节点不预取。
   */
  private nextFrontierReads(fibers: Fiber[], waveKeys: Set<string>, cwd: string): string[] {
    const out: string[] = []
    for (const f of fibers) {
      if (f.done || !f.isHost) continue
      if (f.tool !== "read-file" && f.tool !== "list-dir") continue
      const parentOk = !f.parent || f.parent.done || waveKeys.has(f.parent.key)
      if (!parentOk) continue
      const depsOk = f.deps.every((d) => d in this.results || waveKeys.has(d))
      if (!depsOk) continue
      const p = f.params?.path
      if (typeof p === "string" && !p.includes("$")) {
        out.push(resolvePath(cwd, p))
      }
    }
    return out
  }

  private async runWaves(
    fibers: Fiber[],
    serial: boolean,
    ctx: ToolCtx,
    onEvent?: (e: RuntimeEvent) => void,
    maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
  ): Promise<void> {
    // 事件驱动就绪队列(取代波次屏障):
    // 任一节点完成 → 立即重算依赖, 新就绪的下游立刻入池, 不等待"同波兄弟"。
    // "波次"退化为纯展示分组: 池从空到满的连续忙碌期记为一波, wave-end 在池排空时触发。
    // 全局并发上限 maxConcurrent(默认 min(8, CPU 核)), 防止 shell/LLM 争抢打满。
    const cap = serial ? 1 : Math.max(1, maxConcurrent)
    const running = new Map<Fiber, Promise<void>>()
    let wave: WaveInfo | null = null
    let waveT0 = 0

    const startWave = (): void => {
      if (wave) return
      wave = { n: this.waves.length + 1, parallel: !serial, nodes: [], ms: 0 }
      waveT0 = performance.now()
      onEvent?.({ type: "wave-start", n: wave.n, parallel: !serial })
    }
    const endWave = (): void => {
      if (!wave) return
      wave.ms = performance.now() - waveT0
      onEvent?.({ type: "wave-end", n: wave.n, ms: wave.ms })
      this.waves.push(wave)
      wave = null
    }
    const track = (f: Fiber, p: Promise<void>): void => {
      running.set(f, p)
      void p.finally(() => {
        if (running.get(f) === p) running.delete(f)
      })
    }

    const emitBlockedNow = (f: Fiber): void => {
      startWave()
      onEvent?.({ type: "node-start", key: f.key, tool: f.tool, status: "blocked" })
      onEvent?.({ type: "node-end", key: f.key, tool: f.tool, status: "blocked", ms: 0, error: String(f.error) })
      wave?.nodes.push({ key: f.key, tool: f.tool, ms: 0, status: "blocked", error: String(f.error) })
    }

    while (true) {
      if (ctx.signal?.aborted) throw new Error("[influx] 计划执行已中断(用户取消)")
      // 阻断传播(递归): 依赖失败/被阻断 -> blocked; 父节点 blocked -> 子节点也 blocked
      const blockedKeys = new Set<string>()
      let dirty = true
      while (dirty) {
        dirty = false
        for (const f of fibers) {
          if (f.done) continue
          const depErrs = f.deps.filter((d) => d in this.errors || blockedKeys.has(d))
          const parentBlocked = f.parent !== null && f.parent.status === "blocked"
          if (depErrs.length || parentBlocked) {
            f.done = true
            f.executed = false
            f.status = "blocked"
            f.error = new Error(
              `依赖失败被阻断: ${depErrs.join(", ")}${parentBlocked ? (depErrs.length ? "; 父节点阻断" : "父节点阻断") : ""}`,
            )
            this.stats.blocked++
            this.blocked[f.key] = String(f.error)
            blockedKeys.add(f.key)
            emitBlockedNow(f)
            dirty = true
          }
        }
      }

      // 聚合 Flow 提交: 子树全部完成后, 把 children 输出解析为父节点输出(递归拆解的信息流通关键点)
      this.commitAggregates(fibers)

      // 新就绪前沿(任一依赖完成的瞬间立即可调度); 排除已在池中运行的节点(防重复调度)
      const ready = fibers.filter((f) => !f.done && !running.has(f) && this.ready(f))
      // 预测式预取: 预热"运行中 ∪ 刚就绪"之后会读的输入(后台, 不阻塞)
      if (ctx.prefetch && (ready.length || running.size)) {
        const waveKeys = new Set([...ready.map((f) => f.key), ...[...running.keys()].map((f) => f.key)])
        const reads = this.nextFrontierReads(fibers, waveKeys, ctx.cwd)
        if (reads.length) ctx.prefetch.warm(reads)
      }

      // 填池: 只要有空位就启动就绪节点(不设"波内全部完成"的同步点)
      for (const f of ready) {
        if (running.size >= cap) break
        startWave()
        const nodeCtx: ToolCtx = { ...ctx, key: f.key, rawParams: f.params }
        track(f, this.runOne(f, nodeCtx, onEvent))
      }

      if (running.size === 0) {
        this.commitAggregates(fibers)
        endWave()
        const undone = fibers.filter((f) => !f.done)
        if (undone.length) {
          const allBlocked = undone.every((f) => f.status === "blocked")
          if (allBlocked) {
            // 全部被阻断(无可执行节点): 用一波事件把阻断原因展示出去
            for (const f of undone) emitBlockedNow(f)
            endWave()
            return
          }
          throw new Error(`[influx] deadlock: 依赖未满足 ${undone.map((f) => f.key).join(", ")}`)
        }
        return
      }

      // 等最先完成的节点, 然后立刻回到循环顶部重算就绪 —— 不等待池内其他兄弟
      await Promise.race([...running.values()])
    }
  }

  /** 单节点执行(含重试/结果提交/事件), 永不 reject(错误进 f.error) */
  private async runOne(f: Fiber, nodeCtx: ToolCtx, onEvent?: (e: RuntimeEvent) => void): Promise<void> {    onEvent?.({ type: "node-start", key: f.key, tool: f.tool, status: f.status })
    const start = performance.now()
    try {
      if (f.isHost) {
        // 参数在节点执行时解析: 此时依赖的先前结果已提交到状态
        const state = { results: this.results, errors: this.errors }
        const resolved = resolveRefs(f.params, state)
        f.fallback = resolveRefs(f.fallback, state)
        const retries = f.retries ?? 0
        let lastErr: unknown
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            f.result = await this.getTool(f.tool)(resolved, nodeCtx)
            lastErr = undefined
            break
          } catch (e) {
            lastErr = e
            if (attempt < retries) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
          }
        }
        if (lastErr !== undefined) throw lastErr
      }
    } catch (e) {
      f.error = e
      this.stats.errors++
      log.warn("influx", `节点失败 ${f.key}(${f.tool})`, {
        message: e instanceof Error ? e.message : String(e),
        ms: performance.now() - start,
      })
    }
    f.ms = performance.now() - start
    f.executed = true
    f.done = true
    // 非宿主(Flow)且带聚合输出: 结果由 commitAggregates 在子树完成后统一提交,
    // 这里不能写 undefined 到 results, 否则下游 {$parent.output} 会提前解析到空
    if (!f.isHost && f.aggregate !== undefined) {
      onEvent?.({ type: "node-end", key: f.key, tool: f.tool, status: f.status, ms: f.ms })
      return
    }
    const summary = summarizeResult(f.result, f.tool)
    // 统一提交: 成功写 results; 失败且无 fallback 写 errors(阻断下游); 有 fallback 用兜底值继续
    if (f.error !== undefined) {
      if (f.fallback !== undefined) this.results[f.key] = f.fallback
      else this.errors[f.key] = String(f.error)
    } else {
      this.results[f.key] = f.result
    }
    onEvent?.({
      type: "node-end",
      key: f.key,
      tool: f.tool,
      status: f.status,
      ms: f.ms,
      error: f.error ? String(f.error) : undefined,
      summary,
    })
    const cur = this.waves[this.waves.length - 1]
    cur?.nodes.push({
      key: f.key,
      tool: f.tool,
      ms: f.ms,
      status: f.status,
      error: f.error ? String(f.error) : undefined,
      summary,
    })
  }

  /**
   * 聚合 Flow 提交(递归拆解的信息流通关键点):
   * 被拆解的父节点在计划里是 Flow(key 不变), 下游对 {$parent.output} 的引用必须仍然有效。
   * 子节点全部完成后, 把 aggregate 模板(如 "{$k1a.output}\n{$k1b.output}")解析成父节点输出,
   * 提交到 results[parentKey] —— 下游依赖与引用无感于"它被拆过"。
   * 若所有子节点都失败: 把失败信息挂到 errors[parentKey], 让下游按正常阻断传播处理。
   * 深层嵌套(递归深度 ≥ 2)时子 Flow 的提交可能依赖父 Flow 的后提交 —— 迭代到不动点, 逐层冒泡。
   */
  private commitAggregates(fibers: Fiber[]): void {
    let progress = true
    while (progress) {
      progress = false
      for (const f of fibers) {
        if (f.isHost || f.aggregate === undefined || f.aggregateCommitted) continue
        if (!subtreeDone(f)) continue
        f.aggregateCommitted = true
        progress = true
        const desc = descendants(f)
        const failed = desc.filter((d) => d.error !== undefined || d.status === "blocked")
        if (desc.length > 0 && failed.length === desc.length) {
          // 子节点全部失败: 父节点输出不可用, 按错误阻断下游(信息不静默丢失)
          this.errors[f.key] = `子节点全部失败: ${failed.map((d) => d.key).join(", ")}`
          log.warn("influx", `聚合 Flow ${f.key} 全部子节点失败`, { keys: failed.map((d) => d.key) })
        } else {
          const value = resolveRefs(f.aggregate, { results: this.results, errors: this.errors })
          // 以 { output } 形状提交: 下游 {$parent.output} 引用解析到字符串本身
          this.results[f.key] = { output: value }
          log.debug("influx", `聚合 Flow ${f.key} 提交输出`, { chars: String(value ?? "").length })
        }
        f.done = true
      }
    }
  }
}

/** 该 fiber 的直接子节点(含嵌套后代) */
function descendants(f: Fiber): Fiber[] {
  const out: Fiber[] = []
  const walk = (c: Fiber | null): void => {
    if (!c) return
    out.push(c)
    walk(c.child)
    walk(c.sibling)
  }
  walk(f.child)
  return out
}

/** 子树是否全部完成(聚合 Flow 只有子树完成后才提交输出; 嵌套 Flow 需等其自身聚合先提交) */
function subtreeDone(f: Fiber): boolean {
  return descendants(f).every((d) => d.done && (d.aggregate === undefined || d.aggregateCommitted))
}

// ---------- fiber 构建 ----------

function buildList(list: unknown[], parent: Fiber | null, ctx: { results: Record<string, unknown>; errors: Record<string, string> }): Fiber | null {
  let head: Fiber | null = null
  let prev: Fiber | null = null
  for (const el of list) {
    const f = buildElement(el, parent, ctx)
    if (!f) continue
    if (!head) head = f
    if (prev) prev.sibling = f
    prev = f
  }
  return head
}

function buildElement(el: unknown, parent: Fiber | null, ctx: { results: Record<string, unknown>; errors: Record<string, string> }): Fiber | null {
  if (!el) return null
  if (Array.isArray(el)) return buildList(el, parent, ctx)
  const e = el as Element
  if (typeof e.type !== "function") return null

  if (e.type === Task) {
    const { tool, key, children, dependsOn, when, fallback, retries, ...rest } = e.props
    if (!tool) throw new Error("[influx] <Task> 缺少 tool 属性")
    // 注意: params 保持未解析($ref 延后到节点执行时解析, 以便 dependsOn 的先后结果能串链)
    const params = rest
    // when: 条件表达式, 不满足则节点不进入本轮计划(基于已提交结果求值, 支持 $a.error)
    if (when !== undefined && !evalExpr(String(when), ctx.results, ctx.errors)) return null
    const f: Fiber = {
      key: key ?? "auto-" + hashKey(tool, params),
      tool,
      isHost: true,
      params,
      deps: dependsOn ?? [],
      parent,
      child: null,
      sibling: null,
      done: false,
      executed: false,
      result: undefined,
      fallback,
      retries: retries === undefined ? undefined : Number(retries),
      status: "placement",
      alt: null,
      ms: 0,
    }
    f.params.deps = f.deps
    f.child = buildList(children ?? [], f, ctx)
    return f
  }

  // 函数组件(Flow 等): 纯结构, 无副作用
  const name = (e.type as any).name || "flow"
  const f: Fiber = {
    key: e.props.key ?? name,
    tool: name,
    isHost: false,
    params: {},
    deps: e.props.dependsOn ?? [],
    parent,
    child: null,
    sibling: null,
    done: false,
    executed: false,
    result: undefined,
    status: "placement",
    alt: null,
    ms: 0,
    aggregate: e.props.output,
  }
  const inner = (e.type as any)(e.props)
  f.child = buildElement(inner, f, ctx)
  return f
}

function collect(root: Fiber | null): Fiber[] {
  const out: Fiber[] = []
  const walk = (f: Fiber | null) => {
    if (!f) return
    out.push(f)
    walk(f.child)
    walk(f.sibling)
  }
  walk(root)
  return out
}

// ---------- 判定(供 reconcile 与 preview 共用, 保证预览承诺与执行一致) ----------

function judgeStatus(fibers: Fiber[], getAlt: (key: string) => Fiber | undefined): void {
  const byKey = new Map<string, Fiber>()
  for (const f of fibers) byKey.set(f.key, f)

  // 第一遍: 基础三元判定
  for (const f of fibers) {
    const alt = getAlt(f.key)
    if (!alt || alt.tool !== f.tool) f.status = "placement"
    else if (stable(f.params) === stable(alt.params)) f.status = "skip"
    else f.status = "update"
  }

  // 第二遍: skip 候选若依赖在本轮被重跑(placement/update), 其自身必须同步重跑
  let promoted = true
  while (promoted) {
    promoted = false
    for (const f of fibers) {
      if (f.status !== "skip") continue
      const depRenewed = f.deps.some((d) => {
        const dep = byKey.get(d)
        return !!dep && dep.status !== "skip"
      })
      if (depRenewed) {
        f.status = "update"
        promoted = true
      }
    }
  }
}

// 快速失败: 显式 key 重复会导致 diff 错乱, 宁可报错也不要静默错误
// 自动 key(auto- 前缀)冲突是"同参数去重"的合法语义, 后续重复项自动追加序号
function disambiguateKeys(fibers: Fiber[]): void {
  const seenExplicit = new Set<string>()
  const seenAuto = new Map<string, number>()
  for (const f of fibers) {
    if (f.key.startsWith("auto-")) {
      const n = seenAuto.get(f.key) ?? 1
      if (n > 1) f.key = `${f.key}-${n}`
      seenAuto.set(f.key, n + 1)
    } else {
      if (seenExplicit.has(f.key)) {
        throw new Error(`[influx] 节点 key 重复: ${f.key} — 请为每个 <Task>/<Flow> 指定唯一 key`)
      }
      seenExplicit.add(f.key)
    }
  }
}

// ---------- 值引用解析 ----------
// "$key.path"  -> 引用前序任务结果   "@env.NAME" -> 引用环境变量   "$key.error" -> 引用任务失败信息

function resolveRefs(v: unknown, ctx: { results: Record<string, unknown>; errors: Record<string, string> }): any {
  if (typeof v === "string") {
    const ref = v.match(/^\$([\w-]+)(.*)$/)
    if (ref) {
      const key = ref[1]!
      const path = ref[2]!.replace(/^\./, "")
      if (path === "error") return ctx.errors[key] ?? undefined
      return path ? pick(ctx.results[key], path) : ctx.results[key]
    }
    // 模板插值: 字符串内嵌 {$key.path} 占位符, 替换为前序任务结果
    if (v.includes("{$")) {
      return v.replace(/\{\$([\w-]+)((?:\.\w+)*)\}/g, (_, k, p) => {
        const val = p ? pick(ctx.results[k], p.slice(1)) : ctx.results[k]
        return val === undefined || val === null ? "" : String(val)
      })
    }
    const env = v.match(/^@env\.([\w]+)$/)
    if (env) return process.env[env[1]!]
    return v
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, ctx))
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, any>).map(([k, x]) => [k, resolveRefs(x, ctx)]),
    )
  }
  return v
}

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce((acc, k) => (acc as any)?.[k], obj)
}

// 稳定的序列化: 对象键排序, 避免参数书写顺序不同导致缓存失效
function stable(v: unknown): string {
  return JSON.stringify(sortDeep(v ?? null))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

// ---------- 自动 key ----------
// 未显式指定 key 时, 用 tool+参数哈希生成稳定 key: 参数不变则缓存命中, 参数变了则自动视为新节点重跑
function hashKey(tool: string, params: Record<string, any>): string {
  const { deps, ...rest } = params
  return createHash("sha1").update(tool + ":" + stable(rest)).digest("hex").slice(0, 8)
}

// ---------- when 条件表达式 ----------
// 极简安全求值器(无 eval): 支持 $引用($a.body.ok / $a.error)、数字、字符串、比较(> < >= <= == !=)、逻辑(&& || !)、括号
// 例: when: "$sum.total > 5 && $flag == \"on\"", when: "$a.error == undefined"

function evalExpr(expr: string, results: Record<string, unknown>, errors: Record<string, string> = {}): boolean {
  const s = expr.trim()
  let i = 0
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++
  }
  const fail = (msg: string): never => {
    throw new Error(`[influx] when 表达式错误: ${msg} (${expr})`)
  }
  function prim(): unknown {
    ws()
    const c = s[i]
    if (c === "(") {
      i++
      const v = or()
      ws()
      if (s[i] !== ")") fail("缺少 )")
      i++
      return v
    }
    if (c === "'" || c === '"') {
      let out = ""
      i++
      while (i < s.length && s[i] !== c) out += s[i++]
      if (s[i] !== c) fail("字符串未闭合")
      i++
      return out
    }
    if (c === "$") {
      const m = s.slice(i).match(/^\$([\w.]+)/)
      if (!m) throw new Error(`[influx] when 表达式错误: 无效引用 (${expr})`)
      i += m[0].length
      const path = m[1]!
      const dot = path.lastIndexOf(".")
      const key = dot === -1 ? path : path.slice(0, dot)
      const field = dot === -1 ? "" : path.slice(dot + 1)
      if (field === "error") return errors[key]
      return pick(results, path)
    }
    const num = s.slice(i).match(/^[\d.]+/)
    if (num) {
      i += num[0].length
      return Number(num[0])
    }
    fail(`无法解析 "${s.slice(i, i + 12)}"`)
  }
  function cmp(): unknown {
    const l = prim()
    ws()
    const m = s.slice(i).match(/^(>=|<=|==|!=|>|<)/)
    if (!m) return l
    i += m[0].length
    const r = prim()
    const ln = toNum(l)
    const rn = toNum(r)
    if (ln !== undefined && rn !== undefined) {
      switch (m[0]) {
        case ">": return ln > rn
        case "<": return ln < rn
        case ">=": return ln >= rn
        case "<=": return ln <= rn
        case "==": return ln === rn
        case "!=": return ln !== rn
      }
    }
    const ls = String(l ?? "")
    const rs = String(r ?? "")
    switch (m[0]) {
      case ">": return ls > rs
      case "<": return ls < rs
      case ">=": return ls >= rs
      case "<=": return ls <= rs
      case "==": return ls === rs
      case "!=": return ls !== rs
    }
  }
  function not(): unknown {
    ws()
    if (s[i] === "!") {
      i++
      return !truthy(not())
    }
    return cmp()
  }
  function and(): unknown {
    let v = not()
    ws()
    while (s.slice(i, i + 2) === "&&") {
      i += 2
      v = truthy(v) && truthy(not())
      ws()
    }
    return v
  }
  function or(): unknown {
    let v = and()
    ws()
    while (s.slice(i, i + 2) === "||") {
      i += 2
      v = truthy(v) || truthy(and())
      ws()
    }
    return v
  }
  return truthy(or())
}

function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return v
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v)
  return undefined
}

function truthy(v: unknown): boolean {
  return !(v === undefined || v === false || v === "" || v === 0 || v === null)
}

/** 从工具结果提取简短人类可读摘要(供 UI 对话流展示) */
export function summarizeResult(result: unknown, tool: string): string | undefined {
  if (result === undefined || result === null) return undefined
  const r = result as Record<string, any>
  if (typeof result === "string") return truncateSummary(result, 160)
  // write-file: 优先显示路径(内容可能很长)
  if (tool === "write-file" && typeof r.path === "string") {
    return `${r.path}${typeof r.bytes === "number" ? ` (${r.bytes}B)` : ""}`
  }
  const out = r.output ?? r.answer ?? r.content
  if (typeof out === "string" && out.trim()) return truncateSummary(out.trim(), 160)
  // 结构化: shell -> stdout; read-file -> 路径
  if (typeof r.stdout === "string" && r.stdout.trim()) return truncateSummary(r.stdout.trim(), 160)
  if (typeof r.path === "string") return `${r.path}${typeof r.bytes === "number" ? ` (${r.bytes}B)` : ""}`
  const text = JSON.stringify(r)
  if (text && text !== "{}") return truncateSummary(text, 120)
  return undefined
}

function truncateSummary(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
