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
import { axiomPromptBlock } from "../axiom.ts"
import { agentsMDPromptBlock } from "../agentsmd.ts"
import { log } from "../log.ts"

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
  /** 全局并发上限, 默认 min(8, CPU 核数) */
  maxConcurrent?: number
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
    ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
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

/** 统计 spec 中可执行的 task 节点数(含嵌套子节点; 递归拆解预算检查用) */
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
  cwd = process.cwd(),
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
    "  shell(params:{cmd}) 执行命令(bash/git/build/test) — 参数名**必须是 cmd**, 不要写成 command/script/args; cmd 必须是非空字符串, 引用 {$k.output} 时 k 必须与某个节点的 key 完全一致(拼错 key 会解析为空)",
    "  http.get(params:{url}) / http.post(params:{url,body}) 远端 API",
    "  llm(params:{prompt}) 仅限生成文本/总结, 不作为主要执行手段",
    "- 所有工具统一返回 output 字段, write-file 的 content 引用前序结果一律用 {$k.output}(如 {$rd1.output} 或 {$sum.output})",
    "- 每个 key 唯一, 用 2-4 个小写字母数字",
    "- **每个节点用 desc 字段写一句话注释说明意图**(声明级注释: 做什么、为什么、约束), 执行时按此意图锁定实现, 防止跑偏",
    "- 若任务不适合拆解(纯问答/闲聊), 输出 { type:'task', key:'a1', tool:'llm', params:{prompt:'<原样转发>'}, children:[] }",
    "- 输出合法 JSON, 不要 markdown 代码块",
    "",
    // 基准原则: 动态读取仓库 axiom.md(与对话侧同一底层基调)
    axiomPromptBlock(),
    // 项目规则: 动态读取项目根 AGENTS.md
    agentsMDPromptBlock(cwd),
  ]
    .filter((s) => s !== "")
    .join("\n")

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
  const first = parseSpec(raw)
  if (first.spec) return deepenSpec(client, normalizeSpec(first.spec), task, 0, { model, signal, onStream, cwd })

  // 首次失败: 带具体错误回喂 + 只回喂模型自己的输出尾部(长散文会干扰修正)
  log.warn("plan", "拆解首次解析失败", { error: first.error, raw: (raw ?? "").slice(0, 500) })
  const trimmed = (raw ?? "").slice(-1500)
  const retry = await client.stream({
    messages: [
      { role: "system", content: system },
      { role: "user", content: `任务: ${task}` },
      { role: "assistant", content: trimmed || "(空)" },
      {
        role: "user",
        content: `你上面的输出不是合法计划 JSON(解析错误: ${first.error})。请只输出一个合法 JSON 对象, 不要 markdown 代码块、不要解释、不要多余文字。结构: { type:'flow', key:'root', children:[{type:'task', key:'k1', tool:'<tool>', params:{...}, dependsOn:[]}] }`,
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
  const retryParsed = parseSpec(retry.message.content)
  if (retryParsed.spec) return deepenSpec(client, normalizeSpec(retryParsed.spec), task, 0, { model, signal, onStream, cwd })

  // 第二次失败: 丢弃复杂系统提示, 用极简提示 + 温度 0 做最后一次抢救
  log.warn("plan", "拆解重试仍失败, 极简抢救", { error: retryParsed.error, raw: (retry.message.content ?? "").slice(0, 500) })
  const final = await client.stream({
    messages: [
      { role: "system", content: "你是任务拆解器。只输出一个合法 JSON 对象, 结构: {\"type\":\"flow\",\"key\":\"root\",\"children\":[{\"type\":\"task\",\"key\":\"k1\",\"tool\":\"agent.read\",\"params\":{\"path\":\"文件路径\"}}]}" },
      { role: "user", content: `任务: ${task}` },
    ],
    tools: [],
    model,
    temperature: 0,
    signal,
    onEvent: (e) => {
      if (e.type === "text-delta" && onStream) onStream(e.text)
    },
  })
  const finalParsed = parseSpec(final.message.content)
  if (finalParsed.spec) return deepenSpec(client, normalizeSpec(finalParsed.spec), task, 0, { model, signal, onStream, cwd })
  throw new Error(
    `[plan] LLM 三次返回都不是合法计划 JSON(最后错误: ${finalParsed.error}). 原始输出: ${(final.message.content ?? raw ?? "").slice(0, 200)}`,
  )
}

/**
 * 容错归一化: 模型常见参数名漂移在此纠正, 避免无谓失败。
 * 例: shell 写成 params:{command/script/cmdline} → 归一为 cmd;
 *     http 写成 params:{uri} → 归一为 url。
 */
export function normalizeSpec(spec: unknown): unknown {
  const walk = (s: any): any => {
    if (!s || typeof s !== "object") return s
    if (Array.isArray(s)) return s.map(walk)
    if (typeof s.tool === "string" && s.params && typeof s.params === "object") {
      const p = s.params
      if (s.tool === "shell") {
        // cmd 为空串(模板引用解析为空/模型写空)同样视为缺失, 尝试别名兜底
        if (typeof p.cmd !== "string" || p.cmd === "") {
          if (typeof p.command === "string" && p.command) p.cmd = p.command
          else if (typeof p.script === "string" && p.script) p.cmd = p.script
          else if (typeof p.cmdline === "string" && p.cmdline) p.cmd = p.cmdline
        }
      }
      if (s.tool === "http.get" || s.tool === "http.post" || s.tool === "http_get" || s.tool === "http_post") {
        if (typeof p.url !== "string" && typeof p.uri === "string") p.url = p.uri
      }
    }
    if (Array.isArray(s.children)) s.children = s.children.map(walk)
    return s
  }
  return walk(spec)
}

/**
 * 递归深度拆解(divide & conquer):
 * 顶层 spec 生成后, 对"大"节点(长命令/大写入/agent 模式/描述宽泛)递归再拆一层,
 * 直到深度上限或总节点预算。多个大节点并行子拆解(Promise.all), 不串行等待。
 *
 * 语义连贯性(信息流通)保证:
 * 1. 子节点 key 前缀父 key(`parent_child`), 不会与顶层 key 冲突;
 * 2. 子节点内部的引用(取决于兄弟的 dependsOn / {$k.output} 模板)统一改写成带前缀的 key;
 * 3. 指向"外层既有节点"的引用(如顶层 rd1)保持原样 —— 运行时按全局 results 解析;
 * 4. 父节点变成 Flow + output 聚合模板, 下游 {$parent.output} 引用继续有效;
 * 5. 任何一层子拆解失败 → 父节点原样保留为普通任务(信息不丢失, 退化为叶子)。
 * @param depth 当前深度(0 = 顶层, 1 = 第一层递归, 上限 MAX_DEPTH)
 */
export async function deepenSpec(
  client: ReturnType<typeof createLLMClient>,
  spec: unknown,
  task: string,
  depth = 0,
  opts: { model?: string; signal?: AbortSignal; onStream?: (text: string) => void; cwd?: string } = {},
): Promise<unknown> {
  const MAX_DEPTH = 2
  const MAX_NODES = 40
  const walk = (s: any): unknown => {
    if (!s || typeof s !== "object") return s
    if (Array.isArray(s)) return s.map(walk)
    if (Array.isArray(s.children)) s.children = s.children.map(walk)
    return s
  }
  const deepenOne = async (node: any, level: number): Promise<any> => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node
    if (Array.isArray(node.children)) {
      // 已有子节点(可能是之前递归的结果): 继续深入(深度 +1)
      node.children = await Promise.all(node.children.map((c: any) => deepenOne(c, level + 1)))
      return node
    }
    if (!isBigNode(node) || level >= MAX_DEPTH) return node
    if (countTaskNodes(spec) >= MAX_NODES) return node
    const sub = await subDecompose(node, task, client, opts)
    if (!sub || !Array.isArray(sub.children) || sub.children.length < 2) return node
    // 前缀改 key 并重写内部引用(指向子节点自身的引用加前缀, 外层引用不动)
    const rewritten = rewriteSubKeys(sub.children, node.key ?? "root")
    // 聚合模板: 写文件子节点报告路径(输出是落盘动作), 其余报告 output
    const aggregated = rewritten
      .map((c: any) => (c.tool === "write-file" ? `写文件 {$${c.key}.path}` : `{$${c.key}.output}`))
      .join("\n")
    return {
      type: "flow",
      key: node.key,
      desc: node.desc ?? "",
      dependsOn: node.dependsOn,
      output: aggregated,
      children: rewritten,
    }
  }
  const top = walk(spec) as any
  if (Array.isArray(top)) return Promise.all(top.map((n: any) => deepenOne(n, 0)))
  if (top && typeof top === "object" && Array.isArray(top.children)) {
    top.children = await Promise.all(top.children.map((n: any) => deepenOne(n, 0)))
  }
  return top
}

/** 判断节点是否"大"到值得再拆一层(启发式: 不依赖 LLM 判断, 零额外调用) */
function isBigNode(n: any): boolean {
  if (typeof n !== "object" || n === null) return false
  if (typeof n.tool !== "string") return false
  if (Array.isArray(n.children)) return false
  const p = n.params ?? {}
  const desc = String(n.desc ?? "").slice(0, 120)
  const prompt = String(p.prompt ?? "")
  const content = String(p.content ?? "")
  const cmd = String(p.cmd ?? "")
  const path = String(p.path ?? "")
  // agent 模式的 llm 节点: 内含完整 agent 循环, 最值得切碎
  if (n.tool === "llm" && Array.isArray(p.tools) && p.tools.length) return true
  // 长命令/大写入/长分析
  if (cmd.length > 160) return true
  if (content.length > 800) return true
  if (prompt.length > 300 && n.tool === "llm") return true
  // 描述指向多文件/整体改造(重构/迁移/整个/所有/全部/优化/实现 X 模块)
  if (/整个|全部|所有|重构|迁移|拆分|优化|实现|开发|构建|改造|修复/.test(desc) && path.length === 0) return true
  return false
}

/**
 * 子任务拆解: 一次 LLM 调用, 把单个大节点拆成 2-5 个可并行子节点。
 * 返回 {children:[...]}; 失败返回 null(调用方保留父节点为叶子, 不丢信息)。
 */
async function subDecompose(
  node: any,
  outerTask: string,
  client: ReturnType<typeof createLLMClient>,
  opts: { model?: string; signal?: AbortSignal; onStream?: (text: string) => void; cwd?: string },
): Promise<{ children: unknown[] } | null> {
  const system = [
    "你是计划生成器。把下面这个子任务继续拆分为 2-5 个可并行节点, 只输出 JSON, 不要解释。",
    "输出结构: { children: [{type:'task', key:'<2-4字符>', tool:'<tool>', params:{...}, dependsOn:[], desc:'<一句话意图>'}] }",
    "规则:",
    "- 子节点之间只声明真实数据依赖(dependsOn 用彼此的子 key); 无依赖的子节点不要互相 dependsOn(它们会并行)",
    "- 可用工具: agent.read(params:{path}) / agent.grep(params:{pattern,path}) / agent.glob(params:{pattern}) / write-file(params:{path,content}) / shell(params:{cmd}) / llm(params:{prompt}) / http.get(http.post)",
    "- 子节点间要传递数据时用模板引用 {$<子key>.output}(如 {$a1.output}), 引用关系与 dependsOn 保持一致",
    "- 引用**外层已有节点**的结果: 用 {$<外层key>.output}, key 保持不变(它们是更早完成的兄弟节点)",
    "- shell 参数名必须是 cmd 且非空; 每个子节点必须有 desc",
    "- 拆分粒度: 每个子节点应是单一职责、可独立执行的单元(一个文件/一个命令/一次搜索), 不要拆出互相强耦合的碎片",
  ].join("\n")
  const prompt = [
    `外层任务: ${outerTask.slice(0, 300)}`,
    `待拆解子任务: key=${node.key ?? "?"} tool=${node.tool ?? "?"}`,
    node.desc ? `意图: ${node.desc}` : "",
    `参数: ${JSON.stringify(node.params ?? {}).slice(0, 600)}`,
    "请把这个子任务拆成可并行节点。",
  ]
    .filter((s) => s !== "")
    .join("\n")
  try {
    const res = await client.stream({
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      tools: [],
      model: opts.model,
      temperature: 0.1,
      signal: opts.signal,
      onEvent: (e) => {
        if (e.type === "text-delta" && opts.onStream) opts.onStream(e.text)
      },
    })
    const parsed = parseSpec(res.message.content)
    if (!parsed.spec) {
      log.warn("plan", `子任务 ${node.key} 子拆解解析失败, 保留为叶子`, { error: parsed.error })
      return null
    }
    const s = parsed.spec as any
    let children = Array.isArray(s.children) ? s.children : [s]
    children = normalizeSpec(children) as unknown[]
    return { children }
  } catch (e) {
    log.warn("plan", `子任务 ${node.key} 子拆解调用失败, 保留为叶子`, { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/** 子节点 key 加父前缀, 并重写内部引用(子→子引用加前缀; 外层引用不动) */
function rewriteSubKeys(children: any[], parentKey: string): any[] {
  const remap = new Map<string, string>()
  for (const c of children) {
    const old = String(c.key ?? "")
    const neu = `${parentKey}_${old || "c" + children.indexOf(c)}`
    remap.set(old, neu)
    c.key = neu
  }
  const rewriteRef = (v: unknown): unknown => {
    if (typeof v === "string") {
      // {$k.output} 模板: k 在 remap 里 → 换前缀; 否则保持(外层 key)
      return v.replace(/\{\$([\w-]+)((?:\.\w+)*)\}/g, (_, k, path) => {
        const mapped = remap.get(k)
        return mapped ? `{$${mapped}${path}}` : v
      })
    }
    if (Array.isArray(v)) return v.map(rewriteRef)
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, any>).map(([k, x]) => [k, rewriteRef(x)]))
    }
    return v
  }
  for (const c of children) {
    if (Array.isArray(c.dependsOn)) c.dependsOn = c.dependsOn.map((d: string) => remap.get(d) ?? d)
    c.params = rewriteRef(c.params ?? {}) as Record<string, any>
  }
  return children
}

/** 解析 spec: 成功返回 {spec}, 失败返回 {error}(带 JSON.parse 的具体原因) */
function parseSpec(raw: string): { spec?: unknown; error?: string } {
  if (!raw) return { error: "空输出" }
  // 剥掉 ```json ... ``` 包裹
  let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  // 尝试直接解析
  try {
    const obj = JSON.parse(cleaned)
    if (isSpec(obj)) return { spec: obj }
  } catch (e) {
    // 继续尝试提取 JSON 对象
  }
  // 从文本中提取第一个 {...} 块(容忍模型在前面加了文字说明)
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start !== -1 && end > start) {
    const candidate = cleaned.slice(start, end + 1)
    try {
      const obj = JSON.parse(candidate)
      if (isSpec(obj)) return { spec: obj }
    } catch (e) {
      // 尝试清理单引号/尾逗号后再次解析(常见模型输出瑕疵)
      try {
        const fixed = candidate.replace(/,\s*}/g, "}").replace(/'/g, '"')
        const obj = JSON.parse(fixed)
        if (isSpec(obj)) return { spec: obj }
      } catch (e2) {
        return { error: (e2 as Error).message.slice(0, 120) }
      }
    }
  }
  return { error: "文本中未找到合法 JSON 对象" }
}

function isSpec(obj: unknown): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    ((obj as any).type === "flow" || (obj as any).type === "task" || typeof (obj as any).tool === "string" || Array.isArray((obj as any).children))
  )
}

/** 把计划 spec 渲染成可读树文本(UI 预览/回喂模型用)。含节点 desc 注释(函数级声明注释)。 */
export function renderSpec(spec: unknown): string {
  const walk = (s: any, depth: number): string[] => {
    if (!s) return []
    if (Array.isArray(s)) return s.flatMap((x) => walk(x, depth))
    if (typeof s !== "object") return []
    const indent = "  ".repeat(depth)
    const params = s.params ? " " + JSON.stringify(s.params).slice(0, 80) : ""
    const note = s.desc ? `  // ${s.desc}` : ""
    const line = `${indent}${s.key ?? "?"} [${s.tool ?? s.type ?? "?"}]${params}${note}`
    return [line, ...walk(s.children ?? [], depth + 1)]
  }
  return walk(spec, 0).join("\n")
}
