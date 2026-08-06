// 计划侧修复回归测试(直接调用 runSpec/Runtime, 不经 MCP)
// 覆盖:
//   1. historyMessage: runSpec(task) 返回会话摘要, 多轮上下文不丢失
//   2. signal 中断: 执行中 abort → runSpec 抛出"已中断"
//   3. blocked 节点产生 node-start/node-end 事件(UI 可见阻断原因)
//   4. {$k.output} 引用 write-file 非空
//   5. read-file 50KB 截断 + cwd 相对路径解析
//   6. 多 llm 节点 stream key 按节点分离(并行不串流)
//   7. specHasParallelOps: http 节点走 Influx

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { runSpec, specHasParallelOps, generatePlanSpec } from "../src/influx/plan-runner.ts"
import { Runtime, planFromSpec } from "../src/influx/core.ts"
import { getTool } from "../src/influx/tools.ts"
import { ensureAgentTools } from "../src/influx/agent-tools.ts"
import { VFS } from "../src/vfs.ts"
import { createLLMClient } from "../src/llm.ts"

let failed = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : ` — ${JSON.stringify(detail)?.slice(0, 200)}`}`)
  if (!cond) failed++
}

const dir = mkdtempSync(join(tmpdir(), "plan-fixes-"))
writeFileSync(join(dir, "data.txt"), "line1\nline2\nline3", "utf8")

// ---------- 1. historyMessage(多轮上下文) ----------
{
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "rd", tool: "agent.read", params: { path: join(dir, "data.txt") } },
      { type: "task", key: "wr", tool: "write-file", params: { path: "out.md", content: "{$rd.output}" }, dependsOn: ["rd"] },
    ],
  }
  const vfs = new VFS(dir)
  const rep = await runSpec(spec, { cwd: dir, vfs, task: "把 data.txt 复制为 out.md" })
  check("historyMessage 存在", !!rep.historyMessage)
  check("historyMessage 含任务描述", rep.historyMessage?.content.includes("把 data.txt 复制为 out.md") ?? false)
  check("historyMessage 含节点摘要", (rep.historyMessage?.content.includes("rd") ?? false) && (rep.historyMessage?.content.includes("line1") ?? false))
  check("historyMessage 含文件改动", rep.historyMessage?.content.includes("out.md") ?? false)
}

// ---------- 2. signal 中断 ----------
{
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "a", tool: "shell", params: { cmd: "sleep 5" } },
    ],
  }
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 300)
  const t0 = Date.now()
  let threw = ""
  try {
    await runSpec(spec, { cwd: dir, signal: ctrl.signal })
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  const dt = Date.now() - t0
  check("signal 中断抛错", threw.includes("中断"), threw)
  check("signal 中断及时(<3s)", dt < 3000, dt)
}

// ---------- 3. blocked 节点产生事件 ----------
{
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "fail", tool: "shell", params: { cmd: "exit 1" } },
      { type: "task", key: "dep", tool: "shell", params: { cmd: "echo nope" }, dependsOn: ["fail"] },
      { type: "task", key: "sib", tool: "shell", params: { cmd: "echo still" } },
    ],
  }
  const events: string[] = []
  const rep = await runSpec(spec, {
    cwd: dir,
    onEvent: (e) => {
      if (e.type === "node-start" || e.type === "node-end") events.push(`${e.type}:${e.key}`)
    },
  })
  check("blocked 节点有 node-start", events.includes("node-start:dep"), events)
  check("blocked 节点有 node-end", events.includes("node-end:dep"), events)
  check("依赖失败计入 errors", "fail" in rep.errors)
  check("被阻断计入 blocked", "dep" in rep.blocked)
  check("兄弟节点照常执行", "sib" in rep.results)
}

// ---------- 4. {$k.output} 引用非空 + 5. read-file 截断/cwd ----------
{
  const big = "x".repeat(60 * 1024)
  writeFileSync(join(dir, "big.txt"), big, "utf8")
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "rd", tool: "read-file", params: { path: "big.txt" } },
      { type: "task", key: "wr", tool: "write-file", params: { path: "copy.txt", content: "{$rd.output}" }, dependsOn: ["rd"] },
    ],
  }
  const rep = await runSpec(spec, { cwd: dir })
  const rd = rep.results["rd"] as any
  check("read-file 截断到 50KB 内", (rd?.content?.length ?? 0) < 55 * 1024 && rd?.truncated === true, rd?.content?.length)
  const copy = readFileSync(join(dir, "copy.txt"), "utf8")
  check("write-file 引用 {$rd.output} 非空", copy.length > 50 * 1024, copy.length)
  check("write-file 相对路径落在 ctx.cwd", copy.startsWith("x".repeat(100)))
}

// ---------- 6. 多 llm 节点 stream key 分离 ----------
{
  // 假 LLM: 流式返回 10 个 delta, content 带唯一标记
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw)
      const prompt = String(body.messages?.at(-1)?.content ?? "")
      const tag = prompt.includes("alpha") ? "A" : "B"
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (let i = 0; i < 5; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${tag}${i}` } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const port = (srv.address() as any).port
  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "la", tool: "llm", params: { prompt: "alpha", url } },
      { type: "task", key: "lb", tool: "llm", params: { prompt: "beta", url } },
    ],
  }
  const streams = new Map<string, string>()
  const rep = await runSpec(spec, {
    cwd: dir,
    onEvent: (e) => {
      if (e.type === "stream") streams.set(e.key, (streams.get(e.key) ?? "") + e.text)
    },
  })
  check("la 节点流式独立", streams.get("la") === "A0A1A2A3A4", [...streams.entries()])
  check("lb 节点流式独立", streams.get("lb") === "B0B1B2B3B4", [...streams.entries()])
  check("两个 llm 节点均成功", "la" in rep.results && "lb" in rep.results)
  srv.close()
}

// ---------- 7. specHasParallelOps(http 节点走 Influx) ----------
{
  const httpSpec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "h1", tool: "http.get", params: { url: "https://example.com" } },
      { type: "task", key: "h2", tool: "http.get", params: { url: "https://example.org" } },
      { type: "task", key: "sum", tool: "llm", params: { prompt: "汇总" }, dependsOn: ["h1", "h2"] },
    ],
  }
  check("http spec 走 Influx 并行", specHasParallelOps(httpSpec) === true)
  const llmOnly = { type: "flow", key: "r", children: [{ type: "task", key: "q", tool: "llm", params: { prompt: "hi" } }] }
  check("纯 llm spec 回退对话", specHasParallelOps(llmOnly) === false)
}

// ---------- 8. 拆解思考过程流式可见(onStream 收到 delta) ----------
{
  // 假 LLM: 流式返回 plan JSON(分段吐出)
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      const chunks = ['{"type":"flow","key":"root","children":[', '{"type":"task","key":"a1","tool":"shell",', '"params":{"cmd":"echo ok"}}]}']
      for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const port = (srv.address() as any).port
  const client = createLLMClient({ endpoint: `http://127.0.0.1:${port}/v1/chat/completions` })
  let streamed = ""
  const spec = await generatePlanSpec(client, "跑个命令", undefined, undefined, (t) => (streamed += t))
  check("拆解流式收到全部 delta", streamed.includes("children") && streamed.includes('"cmd":"echo ok"'), streamed)
  check("拆解 spec 解析成功", (spec as any)?.children?.[0]?.tool === "shell")
  srv.close()
}

// ---------- 9. 拆解重试: 首次返回杂音文本, 重试后修正为合法 JSON ----------
{
  let callCount = 0
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      callCount++
      const msgs = JSON.parse(raw).messages
      const last = msgs.at(-1)
      let content: string
      if (last?.role === "user" && String(last.content).includes("上面你给出的不是合法 JSON")) {
        // 重试请求: 返回合法 JSON
        content = '{"type":"flow","key":"root","children":[{"type":"task","key":"a1","tool":"shell","params":{"cmd":"echo ok"}}]}'
      } else if (last?.role === "assistant") {
        content = "好的我重新给出:\n" + '{"type":"flow","key":"root","children":[{"type":"task","key":"a1","tool":"shell","params":{"cmd":"echo ok"}}]}'
      } else {
        // 首次: 返回带杂音的文本(无 JSON)
        content = "这个任务不适合拆解, 我会直接对话处理。"
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const port = (srv.address() as any).port
  const client = createLLMClient({ endpoint: `http://127.0.0.1:${port}/v1/chat/completions` })
  const spec = await generatePlanSpec(client, "跑个命令")
  check("拆解重试次数 >= 2", callCount >= 2, callCount)
  check("重试后 spec 解析成功", (spec as any)?.children?.[0]?.tool === "shell")
  srv.close()
}

// ---------- 10. 拆解容错解析: 模型输出带文字前缀的 JSON ----------
{
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const content = '分析如下:\n```json\n{"type":"flow","key":"root","children":[{"type":"task","key":"a1","tool":"shell","params":{"cmd":"echo ok"}}]}\n```'
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const port = (srv.address() as any).port
  const client = createLLMClient({ endpoint: `http://127.0.0.1:${port}/v1/chat/completions` })
  const spec = await generatePlanSpec(client, "跑个命令")
  check("容错解析(带前缀+代码块)成功", (spec as any)?.children?.[0]?.tool === "shell")
  srv.close()
}

// ---------- 11. 预测式预取: 前一波预热下一前沿的 read-file; read-file 命中缓存 ----------
{
  await ensureAgentTools()
  const rt = new Runtime(getTool)
  const warmCalls: string[][] = []
  const cache = new Map<string, string>()
  const prefetch: import("../src/influx/core.ts").PrefetchCache = {
    get: (p) => cache.get(p),
    invalidate: (p) => {
      cache.delete(p)
    },
    warm: (paths) => {
      warmCalls.push(paths)
      for (const p of paths) cache.set(p, `预取内容:${p}`)
    },
  }
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "w1", tool: "shell", params: { cmd: "echo done" } },
      { type: "task", key: "w2", tool: "read-file", params: { path: "data.txt" }, dependsOn: ["w1"] },
    ],
  }
  const rep = await rt.run(planFromSpec(spec), { cwd: dir, prefetch })
  check("预热包含下一波 read-file 的路径", warmCalls.length >= 1 && warmCalls.some((c) => c.some((p) => p.endsWith("data.txt"))), warmCalls)
  check("read-file 命中预取缓存", (rt.results["w2"] as any)?.prefetched === true)
  check("命中内容为预取内容", String((rt.results["w2"] as any)?.output).includes("预取内容"))
}

// ---------- 12. 预取失效: write-file 写入后 invalidate, read-file 不再命中 ----------
{
  const rt = new Runtime(getTool)
  const cache = new Map<string, string>()
  let invalidated: string[] = []
  const prefetch: import("../src/influx/core.ts").PrefetchCache = {
    get: (p) => cache.get(p),
    invalidate: (p) => {
      cache.delete(p)
      invalidated.push(p)
    },
    warm: (paths) => {
      for (const p of paths) cache.set(p, "stale")
    },
  }
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "w", tool: "write-file", params: { path: "data.txt", content: "new content" } },
    ],
  }
  await rt.run(planFromSpec(spec), { cwd: dir, prefetch })
  check("write-file 触发 invalidate", invalidated.some((p) => p.endsWith("data.txt")), invalidated)
}

// ---------- 回归: 原有 write-file 引用仍工作 ----------
{
  await ensureAgentTools()
  const rt = new Runtime(getTool)
  const spec = {
    type: "flow", key: "root",
    children: [{ type: "task", key: "a", tool: "shell", params: { cmd: "echo hello" } }],
  }
  const rep = await rt.run(planFromSpec(spec), { cwd: dir })
  check("Runtime 直跑 shell 正常", (rt.results["a"] as any)?.stdout === "hello")
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? "PLAN FIXES TEST PASSED" : `PLAN FIXES TEST FAILED: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
