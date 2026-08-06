#!/usr/bin/env node
// Influx MCP 服务器: 把编排运行时暴露给 agent
//   交互循环: influx_tools(可用工具) → influx_plan(干跑 diff 预览, 不执行)
//             → influx_run(执行/增量重跑) → influx_state(查看结果) → influx_reset(重置)
//
// 状态跨工具调用持久 — 对话中任务逐个下发, 每次 run 都基于上一次的计划快照做 diff

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { Runtime, planFromSpec } from "./core.ts"
import type { RunReport } from "./core.ts"
import { getTool, listTools } from "./tools.ts"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

let rt = new Runtime(getTool)

const server = new McpServer({ name: "influx", version: "0.1.0" })

const specSchema = z
  .any()
  .optional()
  .describe(
    "计划树: {type:'task'|'flow', key, tool, params, dependsOn, when, children}。task 节点需要 tool; key 用于跨调用 diff(省略时按 tool+参数自动生成稳定 key); when 为条件表达式(如 \"$a.body.ok == true\"), 不满足则该节点不进入本轮计划; params.fallback 为失败兜底值, 传了则节点失败不阻断下游",
  )

server.tool(
  "influx_tools",
  "列出当前可用的工具: 内置 http.get / http.post / shell / write-file / read-file / list-dir / llm, 以及计划文件注册的自定义工具。下发计划前先调用本工具确认 tool 名。",
  {},
  async () => {
    const tools = listTools()
    const text = tools.map((t) => `${t.name} — ${t.desc ?? "(无描述)"}`).join("\n")
    return { content: [{ type: "text", text: text || "(无工具)" }], structuredContent: { tools } }
  },
)

server.tool(
  "influx_plan",
  "干跑预览: 基于当前状态对计划做 diff 判定(placement 新节点/update 参数变化/skip 缓存命中), 不执行任何工具。下发前先用它确认影响面。",
  { spec: specSchema, planFile: z.string().optional().describe("TSX 计划文件路径(与 spec 二选一)") },
  async ({ spec, planFile }) => {
    try {
      const plan = planFile ? await loadPlan(planFile) : planFromSpec(spec)
      const { nodes } = await rt.preview(plan)
      const text = nodes.length
        ? nodes.map((n) => `${n.key}[${n.tool}] ${n.verdict} — ${n.reason}`).join("\n")
        : "(空计划)"
      return { content: [{ type: "text", text }], structuredContent: { nodes } }
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${e}` }], isError: true }
    }
  },
)

server.tool(
  "influx_run",
  "执行一个 agent 编排计划。计划以 spec(JSON 树)或 planFile(TSX 文件)下发; 重复调用相同计划时未变化节点缓存命中, 仅重跑变化分支, 独立分支并行执行。节点失败默认阻断下游(blocked), 传 fallback 参数可兜底继续。",
  {
    spec: specSchema,
    planFile: z.string().optional().describe("TSX 计划文件路径(与 spec 二选一)"),
    serial: z.boolean().optional().describe("串行执行, 默认并行"),
    maxIter: z.number().optional().describe("最大重渲染迭代数, 默认 8"),
  },
  async ({ spec, planFile, serial, maxIter }) => {
    try {
      const plan = planFile ? await loadPlan(planFile) : planFromSpec(spec)
      if (plan === undefined) throw new Error("计划为空: 需要提供 spec 或 planFile")
      const t0 = performance.now()
      const rep = await rt.run(plan, { serial: serial ?? false, maxIter: maxIter ?? 8 })
      const wall = performance.now() - t0
      return {
        content: [{ type: "text", text: report(rep, wall) }],
        structuredContent: {
          stats: rep.stats,
          wall,
          waves: rep.waves,
          cached: rep.cached,
          blocked: rep.blocked,
          results: rt.results,
          errors: rt.errors,
        },
      }
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  "influx_state",
  "查看当前虚拟状态: 已提交的每个节点结果、失败信息与被阻断节点。重复 run 前可用它确认哪些结果已缓存。",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ results: rt.results, errors: rt.errors, blocked: rt.blocked }),
        },
      ],
      structuredContent: { results: rt.results, errors: rt.errors, blocked: rt.blocked },
    }
  },
)

server.tool("influx_reset", "重置运行时: 清空所有结果与缓存, 下一次 run 全量执行。", {}, async () => {
  rt = new Runtime(getTool)
  return { content: [{ type: "text", text: "runtime reset" }] }
})

async function loadPlan(planFile: string): Promise<unknown> {
  return (await import(pathToFileURL(resolve(planFile)).href)).default
}

function report(rep: RunReport, wall: number): string {
  const s = rep.stats
  const lines = [
    `placement ${s.placed} · update ${s.updated} · cached ${s.skipped} · blocked ${s.blocked} · error ${s.errors} · total ${(wall / 1000).toFixed(2)}s · ${rep.waves.length} waves`,
  ]
  if (rep.cached.length) {
    lines.push(`cached: ${rep.cached.slice(0, 12).join(", ")}${rep.cached.length > 12 ? " …" : ""}`)
  }
  for (const w of rep.waves) {
    lines.push(
      `wave ${w.n}(${w.parallel ? "并行" : "串行"}) ${w.ms.toFixed(0)}ms: ` +
        w.nodes
          .map((n) => `${n.key} ${n.ms.toFixed(0)}ms${n.error ? " ✗" : ""}`)
          .join(", "),
    )
    for (const n of w.nodes) {
      if (n.error) lines.push(`  ${n.key} error: ${truncate(n.error, 400)}`)
    }
  }
  const blk = Object.keys(rep.blocked)
  if (blk.length) {
    lines.push(`blocked: ${blk.slice(0, 12).join(", ")}${blk.length > 12 ? " …" : ""}`)
  }
  return lines.join("\n")
}

server.tool(
  "influx_result",
  "按需获取单个节点的完整结果(避免 influx_run 返回全量结果塞爆上下文)。参数: key(必填, 支持点路径如 'a' 或 'a.answer'); 失败/阻断节点返回其信息。",
  { key: z.string().describe("节点 key, 可带点路径取子字段, 如 'a.answer'") },
  async ({ key }) => {
    const m = key.match(/^([\w-]+)\.?(.*)$/)
    const base = m?.[1] ?? key
    const path = m?.[2] ?? ""
    const raw = rt.results[base]
    if (raw !== undefined) {
      const value = path ? pickPath(raw, path) : raw
      return {
        content: [{ type: "text", text: `${base}${path ? "." + path : ""} = ${truncate(JSON.stringify(value), 300)}` }],
        structuredContent: { ok: true, value },
      }
    }
    const err = rt.errors[base]
    if (err !== undefined) {
      return {
        content: [{ type: "text", text: `${base} -> error: ${truncate(err, 300)}` }],
        structuredContent: { ok: false, error: err },
      }
    }
    const blk = rt.blocked[base]
    if (blk !== undefined) {
      return {
        content: [{ type: "text", text: `${base} -> blocked: ${truncate(blk, 300)}` }],
        structuredContent: { ok: false, blocked: blk },
      }
    }
    return { content: [{ type: "text", text: `key 不存在: ${base} (用 influx_state 查看可用 key)` }], structuredContent: { ok: false } }
  },
)

function pickPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((acc, k) => (acc as any)?.[k], obj)
}

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

const transport = new StdioServerTransport()
await server.connect(transport)
