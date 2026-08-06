// MCP 冒烟测试: 用 SDK client 驱动 src/mcp.ts, 验证完整 agent 交互循环
//   tools 列表 → plan 干跑预览 → run(spec) → 重复 run 缓存命中 → when 条件分支
//   → 自动 key → planFile 加载 → state → reset
//   → 内置文件工具(write/read/list) → llm 智能节点 → 错误阻断 + fallback

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TMP = tmpdir()

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["exec", "tsx", "src/influx/mcp.ts"],
})
const client = new Client({ name: "influx-smoke", version: "0.0.0" })
await client.connect(transport)

const tools = await client.listTools()
console.log("tools:", tools.tools.map((t) => t.name).join(", "))

const t1: any = await client.callTool({ name: "influx_tools", arguments: {} })
console.log("influx_tools:", t1.structuredContent.tools.map((x: any) => x.name).join(", "))

const spec = {
  type: "flow",
  key: "m",
  children: [
    { type: "task", key: "s1", tool: "shell", params: { cmd: "sleep 1" } },
    { type: "task", key: "s2", tool: "shell", params: { cmd: "sleep 1" } },
    {
      type: "task",
      key: "join",
      tool: "shell",
      params: { cmd: "echo ok" },
      dependsOn: ["s1", "s2"],
      when: '$s1.stdout != "failed"',
    },
  ],
}

const p1: any = await client.callTool({ name: "influx_plan", arguments: { spec } })
console.log("plan 预览(应全 placement):", p1.structuredContent.nodes.map((n: any) => n.verdict).join(","))

const r1: any = await client.callTool({ name: "influx_run", arguments: { spec } })
console.log("run1(静态计划单轮, 应 cached=0):", r1.structuredContent.stats)

const p2: any = await client.callTool({ name: "influx_plan", arguments: { spec } })
console.log("plan 预览(应全 skip):", p2.structuredContent.nodes.map((n: any) => n.verdict).join(","))

const r2: any = await client.callTool({ name: "influx_run", arguments: { spec } })
console.log("run2(应全 cached):", r2.structuredContent.stats, "cached:", r2.structuredContent.cached.join(","))

// when 条件不满足: 节点不进计划
const specNo = {
  ...spec,
  children: [
    ...spec.children.slice(0, 2),
    {
      type: "task",
      key: "join",
      tool: "shell",
      params: { cmd: "echo ok" },
      dependsOn: ["s1", "s2"],
      when: '$s1.stdout == "impossible"',
    },
  ],
}
const r3: any = await client.callTool({ name: "influx_plan", arguments: { spec: specNo } })
console.log("when 不满足(join 应缺席):", r3.structuredContent.nodes.map((n: any) => n.key).join(","))

// 自动 key: 无显式 key, 参数相同应缓存命中
const autoSpec = {
  type: "flow",
  key: "a",
  children: [
    { type: "task", tool: "shell", params: { cmd: "echo hi" } },
    { type: "task", tool: "shell", params: { cmd: "echo hi" } },
  ],
}
const r4: any = await client.callTool({ name: "influx_run", arguments: { spec: autoSpec } })
console.log("自动key run:", r4.structuredContent.stats)
const r5: any = await client.callTool({ name: "influx_run", arguments: { spec: autoSpec } })
console.log("自动key 重跑(应全 cached):", r5.structuredContent.stats)

const r6: any = await client.callTool({
  name: "influx_run",
  arguments: { planFile: "examples/shell.plan.tsx", serial: true },
})
console.log("run planFile(串行):", r6.structuredContent.stats)

const st: any = await client.callTool({ name: "influx_state", arguments: {} })
console.log("state keys:", Object.keys(st.structuredContent.results).join(", "))

const rs: any = await client.callTool({ name: "influx_reset", arguments: {} })
console.log("reset:", rs.content[0].text)

const r7: any = await client.callTool({ name: "influx_run", arguments: { spec } })
console.log("reset 后重跑(应全 placement):", r7.structuredContent.stats)

// ---------- 内置文件工具 + llm 智能节点 ----------

// 本地假 LLM 服务, 验证 llm → write-file → read-file 链接
const llmServer = createServer((req, res) => {
  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { content: "fake-llm-answer:" + raw.length } }] }))
  })
})
await new Promise<void>((r) => llmServer.listen(0, r))
const llmPort = (llmServer.address() as any).port
const llmUrl = `http://127.0.0.1:${llmPort}/v1/chat/completions`

const chainSpec = {
  type: "flow",
  key: "fs",
  children: [
    { type: "task", key: "gen", tool: "llm", params: { prompt: "hello", url: llmUrl } },
    {
      type: "task",
      key: "use",
      tool: "write-file",
      params: { path: join(TMP, "influx-smoke/from-llm.md"), content: "$gen.answer" },
      dependsOn: ["gen"],
    },
    { type: "task", key: "check", tool: "read-file", params: { path: join(TMP, "influx-smoke/from-llm.md") }, dependsOn: ["use"] },
    { type: "task", key: "ls", tool: "list-dir", params: { path: join(TMP, "influx-smoke"), recursive: true }, dependsOn: ["use"] },
  ],
}
const rf: any = await client.callTool({ name: "influx_run", arguments: { spec: chainSpec } })
const check = rf.structuredContent.results.check
console.log("llm→write→read:", JSON.stringify(check.content), "| list:", JSON.stringify(rf.structuredContent.results.ls.files))

// ---------- 错误阻断 + fallback ----------

const errSpec = {
  type: "flow",
  key: "e",
  children: [
    { type: "task", key: "fail", tool: "shell", params: { cmd: "exit 1" } },
    { type: "task", key: "dep", tool: "shell", params: { cmd: "echo should-not-run" }, dependsOn: ["fail"] },
    { type: "task", key: "sibling", tool: "shell", params: { cmd: "echo still-runs" } },
  ],
}
const er: any = await client.callTool({ name: "influx_run", arguments: { spec: errSpec } })
console.log(
  "错误阻断: blocked=", er.structuredContent.stats.blocked,
  "| errors=", JSON.stringify(Object.keys(er.structuredContent.errors)),
  "| blocked=", JSON.stringify(Object.keys(er.structuredContent.blocked)),
  "| sibling 执行=", "sibling" in er.structuredContent.results ? "ok" : "FAIL",
  "| dep 未执行=", !("dep" in er.structuredContent.results) && "dep" in er.structuredContent.blocked ? "ok" : "FAIL",
)
const gDep: any = await client.callTool({ name: "influx_result", arguments: { key: "dep" } })
console.log("influx_result dep(应 blocked):", JSON.stringify(gDep.structuredContent.blocked))

const fbSpec = {
  type: "flow",
  key: "f",
  children: [
    { type: "task", key: "boom", tool: "shell", params: { cmd: "exit 2" }, fallback: "fallback-value" },
    { type: "task", key: "after", tool: "shell", params: { cmd: "echo $-ref" }, dependsOn: ["boom"] },
  ],
}
const fr: any = await client.callTool({ name: "influx_run", arguments: { spec: fbSpec } })
console.log(
  "fallback: boom=", JSON.stringify(fr.structuredContent.results.boom),
  "| after 执行=", "after" in fr.structuredContent.results ? "ok" : "FAIL",
  "| blocked=", fr.structuredContent.stats.blocked,
)

// preview 依赖传播: 改上游参数后, 下游即使自身参数未变也应判为 update(预览承诺=执行)
const depSpec = {
  type: "flow",
  key: "dp",
  children: [
    { type: "task", key: "gen", tool: "shell", params: { cmd: "echo v1" } },
    { type: "task", key: "use", tool: "shell", params: { cmd: "echo consumer" }, dependsOn: ["gen"] },
  ],
}
await client.callTool({ name: "influx_run", arguments: { spec: depSpec } })
const depChanged = {
  ...depSpec,
  children: [
    { type: "task", key: "gen", tool: "shell", params: { cmd: "echo v2" } },
    { type: "task", key: "use", tool: "shell", params: { cmd: "echo consumer" }, dependsOn: ["gen"] },
  ],
}
const dp: any = await client.callTool({ name: "influx_plan", arguments: { spec: depChanged } })
const verdicts = Object.fromEntries(dp.structuredContent.nodes.map((n: any) => [n.key, n.verdict]))
console.log(
  "preview 依赖传播: gen=", verdicts.gen,
  "| use(自身参数未变但依赖变化, 应 update)=", verdicts.use,
)

// ---------- 节点级 retry(首败次成) ----------

const retryCnt = join(TMP, "influx-smoke-retry-cnt")
try {
  await import("node:fs").then((fs) => fs.unlinkSync(retryCnt))
} catch {}
const retrySpec = {
  type: "flow",
  key: "rt",
  children: [
    {
      type: "task",
      key: "flaky",
      tool: "shell",
      params: {
        cmd: `if [ -f ${retryCnt} ]; then rm -f ${retryCnt}; echo ok; else touch ${retryCnt}; exit 1; fi`,
      },
      retries: 3,
    },
  ],
}
const rr: any = await client.callTool({ name: "influx_run", arguments: { spec: retrySpec } })
console.log(
  "retry(闪烁节点): flaky stdout=", JSON.stringify(rr.structuredContent.results.flaky?.stdout),
  "| errors=", JSON.stringify(Object.keys(rr.structuredContent.errors)),
  "| blocked=", rr.structuredContent.stats.blocked,
)

// ---------- influx_result 按需取结果 ----------

const g1: any = await client.callTool({ name: "influx_result", arguments: { key: "check.content" } })
console.log("influx_result check.content:", JSON.stringify(g1.structuredContent.value))
const g2: any = await client.callTool({ name: "influx_result", arguments: { key: "boom" } })
console.log("influx_result boom(应失败):", JSON.stringify(g2.structuredContent))
const g3: any = await client.callTool({ name: "influx_result", arguments: { key: "不存在的key" } })
console.log("influx_result 不存在:", g3.structuredContent.ok)

// 重复 key 快速失败
const dupSpec = {
  type: "flow",
  key: "dup",
  children: [
    { type: "task", key: "x", tool: "shell", params: { cmd: "echo 1" } },
    { type: "task", key: "x", tool: "shell", params: { cmd: "echo 2" } },
  ],
}
const dr: any = await client.callTool({ name: "influx_run", arguments: { spec: dupSpec } })
console.log("重复 key(应报错):", dr.isError === true || dr.content[0].text.startsWith("error") ? "ok" : "FAIL: " + dr.content[0].text)

llmServer.close()
await client.close()
console.log("SMOKE TEST PASSED")
