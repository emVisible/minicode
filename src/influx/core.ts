// Influx 运行时 —— mini-react 架构语义移植:
//   render(计划→fiber 任务树) → reconcile(与上一轮快照 diff: placement/update/skip)
//   → commit(就绪前沿并行执行工具, 统一提交结果) → 重规划(计划随状态重渲染, 直到稳定)

import { createHash } from "node:crypto"

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
  return { type: Flow, props: { key: spec.key, dependsOn: spec.dependsOn, children } }
}

export type ToolRun = (params: Record<string, any>, ctx: ToolCtx) => Promise<unknown>

export interface ToolCtx {
  results: Record<string, unknown>
  errors: Record<string, string>
  /** 工作目录(代理给 agent 工具时使用) */
  cwd: string
  /** 写类/命令类工具的确认回调(计划侧默认放行, 由 CLI/MCP 注入) */
  ask: (req: { tool: string; summary: string }) => Promise<boolean>
  /** VBuild 虚拟文件系统: 存在时 write-file/read-file 走内存 overlay, RBuild 统一落盘 */
  vfs?: import("../vfs.ts").VFS
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
}

export interface WaveNode {
  key: string
  tool: string
  ms: number
  status: string
  error?: string
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
  | { type: "node-end"; key: string; tool: string; status: string; ms: number; error?: string }
  | { type: "wave-end"; n: number; ms: number }

export interface RuntimeOptions {
  serial?: boolean
  maxIter?: number
  onEvent?: (e: RuntimeEvent) => void
  cwd?: string
  ask?: (req: { tool: string; summary: string }) => Promise<boolean>
  vfs?: import("../vfs.ts").VFS
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
    const { serial = false, maxIter = 8, onEvent, cwd = process.cwd(), ask = async () => true, vfs } = opts
    this.waves = []
    this.stats = { placed: 0, updated: 0, skipped: 0, blocked: 0, errors: 0 }
    this.lastCached = []
    this.errors = {}
    this.blocked = {}
    const ctx: ToolCtx = { results: this.results, errors: this.errors, cwd, ask, ...(vfs ? { vfs } : {}) }
    // 静态计划(非函数)一次 render 即可收敛; 函数计划随状态重渲染直到稳定
    const maxLoop = typeof plan === "function" ? maxIter : 1

    for (let i = 0; i < maxLoop; i++) {
      onEvent?.({ type: "iter", n: i + 1 })
      const element = typeof plan === "function" ? (plan as any)(this.store) : plan
      this.lastTree = buildElement(element, null, ctx)
      const fibers = collect(this.lastTree)
      disambiguateKeys(fibers)
      const changed = this.reconcile(fibers)
      if (!changed) break
      onEvent?.({ type: "reconcile", stats: { ...this.stats } })
      await this.runWaves(fibers, serial, ctx, onEvent)
      for (const f of fibers) {
        if (!this.fiberInfo.has(f.key)) {
          this.fiberInfo.set(f.key, { status: f.status, ms: f.ms, executed: f.executed })
        }
      }
    }
    return { waves: this.waves, stats: this.stats, cached: this.lastCached, blocked: this.blocked }
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

  private async runWaves(
    fibers: Fiber[],
    serial: boolean,
    ctx: ToolCtx,
    onEvent?: (e: RuntimeEvent) => void,
  ): Promise<void> {
    while (true) {
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
            dirty = true
          }
        }
      }

      const ready = fibers.filter((f) => !f.done && this.ready(f))
      if (ready.length === 0) {
        const undone = fibers.filter((f) => !f.done)
        if (undone.length) {
          throw new Error(`[influx] deadlock: 依赖未满足 ${undone.map((f) => f.key).join(", ")}`)
        }
        return
      }

      const wave: WaveInfo = { n: this.waves.length + 1, parallel: !serial, nodes: [], ms: 0 }
      onEvent?.({ type: "wave-start", n: wave.n, parallel: !serial })
      const t0 = performance.now()

      const runOne = async (f: Fiber) => {
        onEvent?.({ type: "node-start", key: f.key, tool: f.tool, status: f.status })
        const start = performance.now()
        try {
          if (f.isHost) {
            // 参数在节点执行时解析: 此时 dependsOn 的先前波次结果已提交到状态
            const state = { results: this.results, errors: this.errors }
            const resolved = resolveRefs(f.params, state)
            f.fallback = resolveRefs(f.fallback, state)
            const retries = f.retries ?? 0
            let lastErr: unknown
            for (let attempt = 0; attempt <= retries; attempt++) {
              try {
                f.result = await this.getTool(f.tool)(resolved, ctx)
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
        }
        f.ms = performance.now() - start
        f.executed = true
        f.done = true
        onEvent?.({
          type: "node-end",
          key: f.key,
          tool: f.tool,
          status: f.status,
          ms: f.ms,
          error: f.error ? String(f.error) : undefined,
        })
        wave.nodes.push({
          key: f.key,
          tool: f.tool,
          ms: f.ms,
          status: f.status,
          error: f.error ? String(f.error) : undefined,
        })
      }

      if (serial) {
        for (const f of ready) await runOne(f)
      } else {
        await Promise.all(ready.map(runOne))
      }

      wave.ms = performance.now() - t0
      // 统一提交: 成功写 results; 失败且无 fallback 写 errors(阻断下游); 有 fallback 用兜底值继续
      for (const f of ready) {
        if (f.error !== undefined) {
          if (f.fallback !== undefined) this.results[f.key] = f.fallback
          else this.errors[f.key] = String(f.error)
        } else {
          this.results[f.key] = f.result
        }
      }
      onEvent?.({ type: "wave-end", n: wave.n, ms: wave.ms })
      this.waves.push(wave)
    }
  }
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
