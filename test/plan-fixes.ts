// 计划侧修复回归测试(直接调用 runSpec/Runtime, 不经 MCP)
// 覆盖:
//   1. historyMessage: runSpec(task) 返回会话摘要, 多轮上下文不丢失
//   2. signal 中断: 执行中 abort → runSpec 抛出"已中断"
//   3. blocked 节点产生 node-start/node-end 事件(UI 可见阻断原因)
//   4. {$k.output} 引用 write-file 非空
//   5. read-file 50KB 截断 + cwd 相对路径解析
//   6. 多 llm 节点 stream key 按节点分离(并行不串流)
//   7. specHasParallelOps: http 节点走 Influx

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
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
      if (last?.role === "user" && String(last.content).includes("你上面的输出不是合法计划 JSON")) {
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

// ---------- 9b. 拆解三重保险: 前两次失败, 极简提示+温度0 抢救成功 ----------
{
  let callCount = 0
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      callCount++
      const msgs = JSON.parse(raw).messages
      const system = String(msgs[0]?.content ?? "")
      let content: string
      if (system.startsWith("你是任务拆解器")) {
        // 第三次(极简提示): 返回合法 JSON
        content = '{"type":"flow","key":"root","children":[{"type":"task","key":"a1","tool":"agent.read","params":{"path":"a.md"}}]}'
      } else {
        // 前两次: 都返回无 JSON 的散文
        content = "我不会拆解这个任务。"
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
  const spec = await generatePlanSpec(client, "读文件")
  check("三重保险: 第三次抢救成功", callCount === 3 && (spec as any)?.children?.[0]?.tool === "agent.read", `calls=${callCount}`)
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

// ---------- 13. VBuild flushToDisk: write-file 暂存后 shell 可见(修复 bash fix.sh: No such file) ----------
{
  await ensureAgentTools()
  const vfs = new VFS(dir)
  const rt = new Runtime(getTool)
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "w", tool: "write-file", params: { path: "fix.sh", content: "echo fixed" } },
      { type: "task", key: "e", tool: "shell", params: { cmd: "bash fix.sh" }, dependsOn: ["w"] },
    ],
  }
  const rep = await rt.run(planFromSpec(spec), { cwd: dir, vfs })
  check("shell 能看到暂存的 fix.sh", String((rt.results["e"] as any)?.stdout ?? "").includes("fixed"), JSON.stringify(rt.results["e"]))
  check("flush 后磁盘确有 fix.sh", existsSync(join(dir, "fix.sh")))

  // rollback 恢复: 删除 flushed 的文件, 磁盘回到构建前
  const before = existsSync(join(dir, "fix.sh"))
  vfs.rollback()
  check("rollback 清理 flushed 文件", !existsSync(join(dir, "fix.sh")), `before=${before}`)
}

// ---------- 14. VBuild flushToDisk: 修改已有文件 → shell 看到新内容, rollback 还原原文 ----------
{
  const vfs = new VFS(dir)
  const target = join(dir, "data.txt")
  writeFileSync(target, "line1\nline2\nline3", "utf8")
  const rt = new Runtime(getTool)
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "w", tool: "write-file", params: { path: "data.txt", content: "NEW CONTENT" } },
      { type: "task", key: "e", tool: "shell", params: { cmd: "cat data.txt" }, dependsOn: ["w"] },
    ],
  }
  await rt.run(planFromSpec(spec), { cwd: dir, vfs })
  check("shell 看到修改后的内容", String((rt.results["e"] as any)?.stdout ?? "").includes("NEW CONTENT"))
  vfs.rollback()
  check("rollback 还原磁盘原文", readFileSync(target, "utf8").includes("line1"), readFileSync(target, "utf8"))
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

// ---------- 10. 递归拆解: 语义连贯(信息流通) ----------
// 关键断言:
//   a) 大节点被展开成 flow + 子节点, 子 key 带父前缀
//   b) 子节点内部引用(${子key}.output)改写成带前缀的 key
//   c) 外层引用(${父key}.output)在运行时仍能解析到聚合输出 —— 下游无感于"被拆过"
//   d) 子拆解失败 → 父节点原样保留(不丢信息)
{
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw)
      const prompt = String(body.messages?.at(-1)?.content ?? "")
      let content: string
      if (prompt.includes("待拆解子任务")) {
        // 子拆解: 两个可并行子节点, 其中一个引用另一个
        content = '{"children":[{"type":"task","key":"a1","tool":"shell","params":{"cmd":"echo A1"},"desc":"子1"},{"type":"task","key":"a2","tool":"shell","params":{"cmd":"echo {$a1.output}"},"dependsOn":["a1"],"desc":"子2引用子1"}]}'
      } else {
        // 顶层: 一个大节点(big) + 一个消费它的下游(use)
        content =
          '{"type":"flow","key":"root","children":[{"type":"task","key":"big","tool":"llm","params":{"prompt":"' +
          "x".repeat(400) +
          '"},"desc":"重构整个模块, 非常大"},{"type":"task","key":"use","tool":"shell","params":{"cmd":"echo \\"GOT {$big.output}\\" | tr \\"\\\\n\\" \\" \\""},"dependsOn":["big"],"desc":"消费 big 输出"}]}'
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
  const spec = await generatePlanSpec(client, "大任务", undefined, undefined, undefined, dir) as any
  srv.close()

  check("递归: 大节点被展开为 flow", (spec as any)?.children?.find((c: any) => c.key === "big")?.type === "flow", (spec as any)?.children?.map((c: any) => [c.key, c.type]))
  const big = spec.children.find((c: any) => c.key === "big")
  check("递归: 子节点 key 带父前缀", Array.isArray(big?.children) && big.children.every((c: any) => String(c.key).startsWith("big_")), big?.children?.map((c: any) => c.key))
  check(
    "递归: 子节点内部引用被重写",
    big?.children?.some((c: any) => JSON.stringify(c.params).includes("{$big_a1.output}")),
    big?.children?.map((c: any) => c.params),
  )
  check("递归: flow 带聚合输出模板", typeof big?.output === "string" && big.output.includes("{$big_a1.output}"), big?.output)

  // 运行时语义连贯: 顶层 spec 里 use 引用 {$big.output}, 子节点跑完聚合后应解析到 A1
  const rt = new Runtime(getTool)
  const rep = await rt.run(planFromSpec(spec), { cwd: dir })
  check("递归: 外层引用 {$big.output} 仍解析", String((rt.results["use"] as any)?.stdout ?? "").includes("GOT A1"), String((rt.results["use"] as any)?.stdout ?? "").slice(0, 80))
  check("递归: 无错误", Object.keys(rt.errors).length === 0, rt.errors)
}

// ---------- 11. 递归拆解: 子拆解失败保留叶子(信息不丢失) ----------
{
  const srv = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw)
      const prompt = String(body.messages?.at(-1)?.content ?? "")
      let content: string
      if (prompt.includes("待拆解子任务")) {
        content = "这不是 JSON" // 子拆解失败
      } else {
        content = '{"type":"flow","key":"root","children":[{"type":"task","key":"big2","tool":"llm","params":{"prompt":"' + "y".repeat(400) + '"},"desc":"重构整个模块"}]}'
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
  const spec = await generatePlanSpec(client, "大任务2", undefined, undefined, undefined, dir) as any
  srv.close()
  const big2 = spec.children?.find((c: any) => c.key === "big2")
  check("递归: 子拆解失败 → 保留为普通任务(叶子)", big2?.type !== "flow" && typeof big2?.tool === "string", big2)
}

// ---------- 12. 并发上限: maxConcurrent 生效 ----------
{
  const rt = new Runtime(getTool)
  const spec = {
    type: "flow", key: "root",
    children: [
      { type: "task", key: "p1", tool: "shell", params: { cmd: "sleep 0.3" } },
      { type: "task", key: "p2", tool: "shell", params: { cmd: "sleep 0.3" } },
      { type: "task", key: "p3", tool: "shell", params: { cmd: "sleep 0.3" } },
      { type: "task", key: "p4", tool: "shell", params: { cmd: "sleep 0.3" } },
    ],
  }
  // maxConcurrent=2: 同时最多 2 个节点运行 → 总时长 ≥ 0.3*2 = 0.6s, 且不会并行 4 个
  const order: string[] = []
  const t0 = performance.now()
  await rt.run(planFromSpec(spec), { cwd: dir, maxConcurrent: 2, onEvent: (e) => {
    if (e.type === "node-start") order.push(`s:${e.key}`)
    if (e.type === "node-end") order.push(`e:${e.key}`)
  } })
  const elapsed = performance.now() - t0
  // 串行化验证: 前两个完成后第三个才启动(3 个 start 在第 2 个 end 之后)
  const startCountBefore = (s: string) => order.slice(0, order.indexOf(s)).filter((x) => x.startsWith("s:")).length
  const thirdStart = order.filter((x) => x.startsWith("s:")).at(-1)!
  check("maxConcurrent=2: 前 2 完成后第 3 才启动", startCountBefore(thirdStart) >= 2, order.join(" "))
  check(`maxConcurrent=2: 总时长约 2 批 (${(elapsed / 1000).toFixed(2)}s)`, elapsed >= 500, elapsed)
}

// ---------- 13. 递归深度 2: 嵌套 Flow 聚合逐层冒泡(信息流通不丢) ----------
{
  await ensureAgentTools()
  const rt = new Runtime(getTool)
  const outFile = join(dir, "deep-out.txt")
  const spec = {
    type: "flow", key: "root",
    children: [
      {
        type: "flow", key: "big", output: "{$big_c1.output}\n{$big_c2.output}",
        children: [
          { type: "task", key: "big_c1", tool: "shell", params: { cmd: "echo C1" } },
          {
            type: "flow", key: "big_c2", output: "{$big_c2_g1.output}|{$big_c2_g2.output}",
            children: [
              { type: "task", key: "big_c2_g1", tool: "shell", params: { cmd: "echo G1" } },
              { type: "task", key: "big_c2_g2", tool: "shell", params: { cmd: "echo G2" } },
            ],
          },
        ],
      },
      { type: "task", key: "use", tool: "write-file", params: { path: outFile, content: "GOT:{$big.output}" }, dependsOn: ["big"] },
    ],
  }
  const rep = await rt.run(planFromSpec(spec), { cwd: dir })
  const got = String((rt.results["use"] as any)?.output ?? "")
  check("递归深度2: 两层聚合都冒泡到下游", got.includes("GOT:C1") && got.includes("G1|G2"), got)
  check("递归深度2: 无错误", Object.keys(rt.errors).length === 0, rt.errors)
}


rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? "PLAN FIXES TEST PASSED" : `PLAN FIXES TEST FAILED: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
