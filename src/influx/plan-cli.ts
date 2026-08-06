// Influx 计划 CLI —— 可调用模块: minicode plan run|bench|view <plan.tsx>
// 由统一入口 src/cli.ts 分发; 也保留独立启动能力(minicode plan ...)

import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { Runtime } from "./core.ts"
import type { Fiber, RunReport } from "./core.ts"
import { getTool } from "./tools.ts"
import { ensureAgentTools } from "./agent-tools.ts"

const execAsync = promisify(execCb)
const here = dirname(fileURLToPath(import.meta.url))

export interface PlanCliFlags {
  serial: boolean
  rerun: boolean
  noOpen: boolean
  maxIter: number
}

export function parsePlanFlags(flags: string[]): PlanCliFlags {
  return {
    serial: flags.includes("--serial"),
    rerun: flags.includes("--rerun"),
    noOpen: flags.includes("--no-open"),
    maxIter: Number(flags.find((f) => f.startsWith("--max-iter="))?.split("=")[1] ?? 8),
  }
}

export const planUsage = `用法:
  minicode plan run <plan.tsx>    [--serial] [--rerun] [--max-iter=N]
  minicode plan bench <plan.tsx>  [--max-iter=N]
  minicode plan view <plan.tsx>   [--serial] [--max-iter=N] [--no-open]   # 浏览器可视化`

async function loadPlan(file: string): Promise<unknown> {
  const mod = await import(pathToFileURL(resolve(file)).href)
  if (mod.default === undefined) throw new Error(`[influx] ${file} 没有 default 导出计划`)
  return mod.default
}

export async function runPlanFile(file: string, flags: PlanCliFlags): Promise<void> {
  const plan = await loadPlan(file)
  await ensureAgentTools()
  const rt = new Runtime(getTool)
  const t0 = performance.now()
  const rep = await rt.run(plan, { serial: flags.serial, maxIter: flags.maxIter })
  const wall = performance.now() - t0
  printReport(rt, rep, wall, flags.serial, file)

  if (flags.rerun) {
    const t1 = performance.now()
    const rep2 = await rt.run(plan, { serial: flags.serial, maxIter: flags.maxIter })
    const wall2 = performance.now() - t1
    console.log("\n── 重跑 (增量验证: 未变化节点应全部缓存命中) ──")
    printStats(rep2, wall2, rep2.waves.length)
  }
}

export async function benchPlanFile(file: string, flags: PlanCliFlags): Promise<void> {
  const plan = await loadPlan(file)
  const parallel = new Runtime(getTool)
  const s = new Runtime(getTool)

  const t0 = performance.now()
  const rp = await parallel.run(plan, { maxIter: flags.maxIter })
  const pms = performance.now() - t0

  const t1 = performance.now()
  const rs = await s.run(plan, { serial: true, maxIter: flags.maxIter })
  const sms = performance.now() - t1

  const pExec = rp.stats.placed + rp.stats.updated
  const sExec = rs.stats.placed + rs.stats.updated

  console.log(`[bench] ${file}`)
  console.log(`  serial:   ${sms.toFixed(0)}ms   (${sExec} 次执行, ${rs.waves.length} 波)`)
  console.log(`  parallel: ${pms.toFixed(0)}ms   (${pExec} 次执行, ${rp.waves.length} 波)`)
  console.log(`  speedup:  ${(sms / pms).toFixed(2)}x`)
  if (pExec !== sExec) console.log(`  注: 两模式执行次数不同 (${pExec} vs ${sExec}), 速度比仅供参考`)
}

// ---------- 报告 ----------

function printReport(rt: Runtime, rep: RunReport, wall: number, serial: boolean, file: string) {
  const treeInfo = rt.fiberInfo
  console.log(`[influx] run ${file} — 总耗时 ${(wall / 1000).toFixed(2)}s`)
  console.log()
  console.log("Task tree:")
  printTree(rt.lastTree, treeInfo, "", true)
  console.log()
  console.log(`Execution waves (${serial ? "serial" : "parallel"}):`)
  for (const w of rep.waves) {
    const nodes = w.nodes.map((n) => {
      const err = n.error ? ` [ERROR: ${truncate(n.error, 80)}]` : ""
      return `${n.key}[${n.tool}] ${n.ms.toFixed(1)}ms${err}`
    })
    const mode = w.parallel ? `并行 ${w.ms.toFixed(0)}ms` : `串行 ${w.ms.toFixed(0)}ms`
    console.log(`  wave ${w.n}: ${nodes.join(" | ")}   (${mode})`)
  }
  if (rep.waves.length === 0) console.log("  (无执行 — 全部缓存命中)")
  console.log()
  printStats(rep, wall, rep.waves.length)
  console.log()
  console.log("Results:")
  for (const [k, v] of Object.entries(rt.results)) {
    if (v === undefined) continue
    console.log(`  ${k}: ${truncate(v)}`)
  }
  if (Object.keys(rt.blocked).length) {
    console.log("Blocked:")
    for (const [k, v] of Object.entries(rt.blocked)) {
      console.log(`  ${k}: ${truncate(v, 100)}`)
    }
  }
  if (Object.keys(rt.errors).length) {
    console.log("Errors:")
    for (const [k, v] of Object.entries(rt.errors)) {
      console.log(`  ${k}: ${truncate(v, 100)}`)
    }
  }
}

function printStats(rep: RunReport, wall: number, waves: number) {
  console.log(`Reconcile: placement ${rep.stats.placed}, update ${rep.stats.updated}, skip(缓存命中) ${rep.stats.skipped}, blocked ${rep.stats.blocked}, error ${rep.stats.errors}`)
  if (rep.cached.length) console.log(`cached: ${rep.cached.slice(0, 12).join(", ")}${rep.cached.length > 12 ? " …" : ""}`)
  console.log(`Total: ${(wall / 1000).toFixed(2)}s, ${waves} 波`)
}

function printTree(
  f: Fiber | null,
  info: Map<string, { status: string; ms: number; executed: boolean }>,
  indent: string,
  last: boolean,
): void {
  if (!f) return
  const mark = indent === "" ? "" : last ? "└─ " : "├─ "
  const detail = info.get(f.key)
    ? (() => {
        const i = info.get(f.key)!
        return i.executed
          ? ` ${i.ms.toFixed(1)}ms`
          : i.status === "skip"
            ? " (cached)"
            : i.status === "blocked"
              ? ` (blocked${f.error ? ": " + truncate(String(f.error).split("\n")[0], 60) : ""})`
              : ""
      })()
    : ""
  console.log(`${indent}${mark}${f.key}[${f.tool}] ${info.get(f.key)?.status ?? f.status}${detail}`)
  const childIndent = indent === "" ? "  " : indent + (last ? "   " : "│  ")
  printTree(f.child, info, childIndent, f.child ? !f.child.sibling : false)
  printTree(f.sibling, info, indent, f.sibling ? !f.sibling.sibling : false)
}

function truncate(v: unknown, n = 140): string {
  const s = v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v)
  return s.length > n ? s.slice(0, n) + "…" : s
}

// ---------- 可视化面板 ----------

export async function viewPlanFile(file: string, flags: PlanCliFlags): Promise<void> {
  const html = readFileSync(resolve(here, "view.html"), "utf8")
  const plan = await loadPlan(file)
  const events: unknown[] = []
  const clients = new Set<import("node:http").ServerResponse>()
  const broadcast = (e: unknown) => {
    events.push(e)
    const payload = `event: evt\ndata: ${JSON.stringify(e)}\n\n`
    for (const res of clients) res.write(payload)
  }

  const rt = new Runtime(getTool)
  const t0 = performance.now()

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(html)
    } else if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      clients.add(res)
      for (const e of events) res.write(`event: evt\ndata: ${JSON.stringify(e)}\n\n`)
      res.on("close", () => clients.delete(res))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  server.listen(0, async () => {
    const port = (server.address() as import("node:net").AddressInfo).port
    const url = `http://localhost:${port}`
    console.log(`[influx] 可视化面板: ${url}`)
    broadcast({ type: "run", plan: file, serial: flags.serial })
    if (!flags.noOpen) execAsync(`open ${url}`).catch(() => {})
    try {
      const rep = await rt.run(plan, {
        serial: flags.serial,
        maxIter: flags.maxIter,
        onEvent: (e) =>
          broadcast(
            e.type === "reconcile"
              ? { ...e, tree: serializeTree(rt.lastTree, rt.fiberInfo) }
              : e,
          ),
      })
      broadcast({
        type: "done",
        wall: performance.now() - t0,
        stats: rep.stats,
        results: rt.results,
        tree: serializeTree(rt.lastTree, rt.fiberInfo),
      })
      console.log("[influx] 执行完成, 面板实时查看中 (Ctrl+C 退出)")
    } catch (e) {
      broadcast({ type: "error", message: String(e) })
      console.error(`[influx] 执行失败: ${e}`)
    }
  })
}

function serializeTree(
  f: Fiber | null,
  info: Map<string, { status: string; ms: number; executed: boolean }>,
): any {
  if (!f) return null
  const i = info.get(f.key)
  return {
    key: f.key,
    tool: f.tool,
    status: i?.status ?? f.status,
    ms: i?.ms ?? f.ms,
    executed: i?.executed ?? f.executed,
    error: f.error ? String(f.error) : undefined,
    child: serializeTree(f.child, info),
    sibling: serializeTree(f.sibling, info),
  }
}
