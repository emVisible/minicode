// 对话内全并行计划执行 —— /plan 命令的引擎
// 用户给一段任务描述 → LLM 生成 Influx 计划 spec(声明式 DAG, 无依赖分支可任意并行)
// → 交给 Runtime 全并行执行(波次调度), 事件桥接到对话 UI 的任务树。
//
// 这是"双引擎一体化"的关键路径: 对话负责理解任务, Influx 负责全并行执行。

import { Runtime, planFromSpec, summarizeResult } from "./core.ts"
import type { RuntimeEvent } from "./core.ts"
import { getTool } from "./tools.ts"
import { ensureAgentTools } from "./agent-tools.ts"
import { createLLMClient, resolveEndpoint } from "../llm.ts"

export interface PlanRunResult {
  ok: boolean
  waves: number
  stats: { placed: number; updated: number; skipped: number; blocked: number; errors: number }
  /** 每个节点结果(结构化), 供回喂模型/展示 */
  results: Record<string, unknown>
  errors: Record<string, string>
  blocked: Record<string, string>
  message: string
  /** 总耗时 ms */
  wallMs: number
  /** 执行摘要(供会话历史: 下一条用户消息能看到本轮做了什么) */
  historyMessage?: import("../types.ts").ChatMessage
}

/**
 * 用 LLM 生成计划 spec 并全并行执行。
 * @param task 用户任务描述
 * @param onPlan spec 生成后回调(供 UI 预览/记录)
 * @param onEvent Runtime 事件(供任务树实时渲染)
 */
export async function runPlannedTask(
  task: string,
  opts: {
    model?: string
    url?: string
    onPlan?: (spec: unknown) => void
    onEvent?: (e: RuntimeEvent) => void
    ask?: (req: { tool: string; summary: string }) => Promise<boolean>
    cwd?: string
    vfs?: import("../vfs.ts").VFS
    signal?: AbortSignal
    /** 拆解阶段 LLM 流式输出回调(思考过程可视化) */
    onStream?: (text: string) => void
    /** 预测式预取缓存 */
    prefetch?: import("./core.ts").PrefetchCache
  } = {},
): Promise<PlanRunResult> {
  const client = createLLMClient({ endpoint: opts.url ? resolveEndpoint(opts.url) : undefined })
  const spec = await generatePlanSpec(client, task, opts.model, opts.signal, opts.onStream)
  opts.onPlan?.(spec)
  return runSpec(spec, { ...opts, task })
}

export interface RunSpecOpts {
  model?: string
  url?: string
  onEvent?: (e: RuntimeEvent) => void
  ask?: (req: { tool: string; summary: string }) => Promise<boolean>
  cwd?: string
  vfs?: import("../vfs.ts").VFS
  signal?: AbortSignal
  /** 用户任务描述(用于生成 historyMessage) */
  task?: string
  /** 预测式预取缓存(在拆解/前一波执行期间预读后续 read-file 输入) */
  prefetch?: import("./core.ts").PrefetchCache
}

/** 给定 spec 直接执行(不再生成) —— 供双引擎自动分流复用 */
export async function runSpec(spec: unknown, opts: RunSpecOpts = {}): Promise<PlanRunResult> {
  await ensureAgentTools()
  const rt = new Runtime(getTool)
  const plan = planFromSpec(spec)
  const t0 = performance.now()
  const rep = await rt.run(plan, {
    cwd: opts.cwd ?? process.cwd(),
    ask: opts.ask ?? (async () => true),
    onEvent: opts.onEvent,
    ...(opts.vfs ? { vfs: opts.vfs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.prefetch ? { prefetch: opts.prefetch } : {}),
  })
  const wallMs = performance.now() - t0
  const failed = Object.keys(rt.errors).length + Object.keys(rt.blocked).length
  const staged = opts.vfs?.hasChanges() ? opts.vfs.summary() : undefined
  return {
    ok: failed === 0,
    waves: rep.waves.length,
    stats: rep.stats,
    results: rt.results,
    errors: rt.errors,
    blocked: rt.blocked,
    message: `计划执行完成: ${rep.waves.length} 波, placement ${rep.stats.placed}, cached ${rep.stats.skipped}, 失败 ${failed}${staged ? `, VBuild 暂存 ${staged.create} 创建/${staged.modify} 修改/${staged.del} 删除` : ""}`,
    wallMs,
    ...(opts.task ? { historyMessage: buildHistoryMessage(opts.task, rep, rt, opts) } : {}),
  }
}

/** 把一次计划执行压成一条 assistant 消息, 供会话历史(多轮上下文不丢失) */
function buildHistoryMessage(
  task: string,
  rep: import("./core.ts").RunReport,
  rt: Runtime,
  opts: RunSpecOpts,
): import("../types.ts").ChatMessage {
  const lines: string[] = [`[Influx 计划执行] 任务: ${task}`, ""]
  lines.push(`执行: ${rep.waves.length} 波, ${rep.stats.placed} 新节点, ${rep.stats.skipped} 缓存命中, 失败 ${Object.keys(rt.errors).length + Object.keys(rt.blocked).length}`)
  for (const [k, v] of Object.entries(rt.results)) {
    if (v === undefined) continue
    const s = summarizeResult(v, toolNameFor(rep, k))
    lines.push(`- ${k}: ${s ?? String(v).slice(0, 80)}`)
  }
  for (const [k, e] of Object.entries(rt.errors)) lines.push(`- ${k}: 失败 ${e.slice(0, 120)}`)
  for (const [k, b] of Object.entries(rt.blocked)) lines.push(`- ${k}: 被阻断 ${b.slice(0, 120)}`)
  if (opts.vfs?.hasChanges()) {
    lines.push("", "文件改动(VBuild 暂存):")
    for (const c of opts.vfs.diff()) {
      lines.push(`- ${c.kind === "create" ? "+" : c.kind === "delete" ? "−" : "~"} ${c.path} (${c.bytes}B)`)
    }
  }
  return { role: "assistant", content: lines.join("\n") }
}

/** 从 wave 节点列表反查节点工具名(historyMessage 摘要用) */
function toolNameFor(rep: import("./core.ts").RunReport, key: string): string {
  for (const w of rep.waves) {
    const n = w.nodes.find((n) => n.key === key)
    if (n) return n.tool
  }
  return ""
}

/** 统计 spec 中可执行的 task 节点数(用于判断是否值得走并行路径) */
export function countTaskNodes(spec: unknown): number {
  const walk = (s: any): number => {
    if (!s) return 0
    if (Array.isArray(s)) return s.reduce((a, x) => a + walk(x), 0)
    if (typeof s !== "object") return 0
    const self = s.type === "task" || typeof s.tool === "string" ? 1 : 0
    return self + walk(s.children ?? [])
  }
  return walk(spec)
}

/** 检查 spec 是否包含实际可并行操作节点(文件 / 命令 / 远端 API); 纯 llm 问答则回退对话 */
export function specHasParallelOps(spec: unknown): boolean {
  const FILE_TOOLS = new Set([
    "agent.read", "agent.write", "agent.edit", "agent.bash", "agent.glob", "agent.grep",
    "read-file", "write-file", "list-dir", "shell",
    "http.get", "http.post", "http_get", "http_post",
  ])
  const walk = (s: any): boolean => {
    if (!s) return false
    if (Array.isArray(s)) return s.some(walk)
    if (typeof s !== "object") return false
    if (typeof s.tool === "string" && FILE_TOOLS.has(s.tool)) return true
    return walk(s.children ?? [])
  }
  return walk(spec)
}

/**
 * 让 LLM 把任务描述转成 Influx 计划 spec(JSON)。
 * 要求: 只输出 JSON; 节点是独立的可并行单元; 依赖用 dependsOn 声明;
 * 工具名限制为 influx 内置 + agent.* 桥接(详见 system 提示)。
 * @param onStream 流式 delta 回调(拆解思考过程可视化)
 */
export async function generatePlanSpec(
  client: ReturnType<typeof createLLMClient>,
  task: string,
  model?: string,
  signal?: AbortSignal,
  onStream?: (text: string) => void,
): Promise<unknown> {
  const system = [
    "你是计划生成器。把用户任务拆解为 Influx 计划(JSON spec), 只输出 JSON, 不要任何解释。",
    "spec 结构: { type:'flow', key:'root', children:[{type:'task', key:'k1', tool:'<tool>', params:{...}, dependsOn:['k2']}] }",
    "规则:",
    "- 把任务拆成 3-8 个可独立执行的节点; 无依赖的节点不要互相 dependsOn(它们会全并行执行)",
    "- 只有真实数据依赖才用 dependsOn(如: 先读文件再基于内容写文件)",
    "- **禁止用 llm 节点做任务主体**。llm 节点只用于: 生成文本内容(如报告/文案)、汇总前序结果。",
    "  需要读文件/搜索/执行/修改时, 必须用文件工具:",
    "- 可用工具:",
    "  agent.glob(params:{pattern}) 搜索文件(如 '**/*.tsx')",
    "  agent.grep(params:{pattern,path}) 搜索内容",
    "  agent.read(params:{path}) 读文件",
    "  write-file(params:{path,content}) 写文件(可引用前序结果 {$k1.output})",
    "  shell(params:{cmd}) 执行命令(bash/git/build/test)",
    "  http.get(params:{url}) / http.post(params:{url,body}) 远端 API",
    "  llm(params:{prompt}) 仅限生成文本/总结, 不作为主要执行手段",
    "- 所有工具统一返回 output 字段, write-file 的 content 引用前序结果一律用 {$k.output}(如 {$rd1.output} 或 {$sum.output})",
    "- 每个 key 唯一, 用 2-4 个小写字母数字",
    "- 若任务不适合拆解(纯问答/闲聊), 输出 { type:'task', key:'a1', tool:'llm', params:{prompt:'<原样转发>'}, children:[] }",
    "- 输出合法 JSON, 不要 markdown 代码块",
  ].join("\n")

  const res = await client.stream({
    messages: [
      { role: "system", content: system },
      { role: "user", content: `任务: ${task}` },
    ],
    tools: [],
    model,
    temperature: 0.1,
    signal,
    onEvent: (e) => {
      // 拆解思考过程流式转发给 UI(与 llm 节点 thinking 可视化一致)
      if (e.type === "text-delta" && onStream) onStream(e.text)
    },
  })
  const raw = res.message.content
  const parsed = tryParseSpec(raw)
  if (parsed) return parsed

  // 首次解析失败: 把模型自己的输出回喂, 让其修正为合法 JSON(一次机会)
  const retry = await client.stream({
    messages: [
      { role: "system", content: system },
      { role: "user", content: `任务: ${task}` },
      {
        role: "assistant",
        content: raw ?? "",
      },
      {
        role: "user",
        content:
          "上面你给出的不是合法 JSON 计划。请只输出一个合法 JSON 对象(不要 markdown 代码块、不要解释、不要多余文字), 结构: { type:'flow', key:'root', children:[{type:'task', key:'k1', tool:'<tool>', params:{...}, dependsOn:[]}] }",
      },
    ],
    tools: [],
    model,
    temperature: 0.1,
    signal,
    onEvent: (e) => {
      if (e.type === "text-delta" && onStream) onStream(e.text)
    },
  })
  const retryParsed = tryParseSpec(retry.message.content)
  if (retryParsed) return retryParsed
  throw new Error(`[plan] LLM 两次返回都不是合法计划 JSON: ${(retry.message.content ?? raw ?? "").slice(0, 300)}`)
}

/** 容忍模型输出 ```json 包裹或前后杂音; 找不到 JSON 对象则返回 null */
function tryParseSpec(raw: string): unknown {
  if (!raw) return null
  // 剥掉 ```json ... ``` 包裹
  let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  // 尝试直接解析
  try {
    const obj = JSON.parse(cleaned)
    if (isSpec(obj)) return obj
  } catch {
    // 继续尝试提取 JSON 对象
  }
  // 从文本中提取第一个 {...} 块(容忍模型在前面加了文字说明)
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start !== -1 && end > start) {
    const candidate = cleaned.slice(start, end + 1)
    try {
      const obj = JSON.parse(candidate)
      if (isSpec(obj)) return obj
    } catch {
      // 尝试清理单引号/尾逗号后再次解析(常见模型输出瑕疵)
      try {
        const fixed = candidate.replace(/,\s*}/g, "}").replace(/'/g, '"')
        const obj = JSON.parse(fixed)
        if (isSpec(obj)) return obj
      } catch {
        return null
      }
    }
  }
  return null
}

function isSpec(obj: unknown): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    ((obj as any).type === "flow" || (obj as any).type === "task" || typeof (obj as any).tool === "string" || Array.isArray((obj as any).children))
  )
}

/** 把计划 spec 渲染成可读树文本(UI 预览/回喂模型用) */
export function renderSpec(spec: unknown): string {
  const walk = (s: any, depth: number): string[] => {
    if (!s) return []
    if (Array.isArray(s)) return s.flatMap((x) => walk(x, depth))
    if (typeof s !== "object") return []
    const indent = "  ".repeat(depth)
    const line = `${indent}${s.key ?? "?"} [${s.tool ?? s.type ?? "?"}]${s.params ? " " + JSON.stringify(s.params).slice(0, 80) : ""}`
    return [line, ...walk(s.children ?? [], depth + 1)]
  }
  return walk(spec, 0).join("\n")
}
