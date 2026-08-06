// 端到端冒烟测试: 脚本化假 LLM server 驱动完整回环, 不依赖真实网络
// 验证: tool-call 回环 / 工具结果回喂 / 死循环检测 / 参数解析失败 / 会话消息演进

import { createServer } from "node:http"
import { builtinTools } from "../src/tools.ts"
import { LLMClient } from "../src/llm.ts"
import { runAgent } from "../src/loop.ts"
import type { RunResult } from "../src/loop.ts"
import { buildSystemPrompt } from "../src/prompt.ts"
import type { ChatMessage } from "../src/types.ts"

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ""}`)
  }
}

// ---------- 假 LLM server ----------

interface Scenario {
  name: string
  toolCalls: (msgs: ChatMessage[]) => { name: string; args: string }[] | undefined
  finalText: (msgs: ChatMessage[]) => string
  /** 每次都返回同一个 tool-call(制造死循环) */
  doom?: boolean
}

function makeServer(scenario: Scenario): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end()
        return
      }
      let raw = ""
      for await (const chunk of req) raw += chunk.toString("utf8")
      const body = JSON.parse(raw)
      const msgs: ChatMessage[] = body.messages

      const last = msgs.at(-1)
      let reply: { text?: string; calls?: { name: string; args: string }[]; finish: string }

      if (scenario.doom) {
        // 死循环场景: 无论上下文如何, 永远返回同一个 tool-call
        reply = { calls: scenario.toolCalls(msgs), finish: "tool_calls" }
      } else if (last?.role === "tool") {
        reply = { text: scenario.finalText(msgs), finish: "stop" }
      } else {
        const calls = scenario.toolCalls(msgs)
        if (calls?.length) reply = { calls, finish: "tool_calls" }
        else reply = { text: scenario.finalText(msgs), finish: "stop" }
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      if (reply.text !== undefined) {
        for (const piece of reply.text.match(/.{1,8}/gs) ?? []) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, index: 0 }] })}\n\n`)
        }
      }
      if (reply.calls) {
        const calls = reply.calls.map((c, i) => ({
          index: i,
          id: `call_${i}`,
          type: "function",
          function: { name: c.name, arguments: c.args },
        }))
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, index: 0 }, { finish_reason: "tool_calls" }] })}\n\n`,
        )
      }
      res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: reply.finish, index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") throw new Error("no addr")
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

// ---------- 场景: 读文件 → 写文件 → 总结 ----------

async function runScenario(
  scenario: Scenario,
  prompt: string,
  ask: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<{ port: number; run: () => Promise<RunResult> }> {
  const { port, close } = await makeServer(scenario)
  const client = new LLMClient({ endpoint: `http://127.0.0.1:${port}/v1/chat/completions` })
  const tools = builtinTools()
  const system = buildSystemPrompt({ cwd: process.cwd(), tools })
  return {
    port,
    run: () =>
      runAgent({
        history: [],
        userMessage: { role: "user", content: prompt },
        tools,
        system,
        cwd: process.cwd(),
        requests: (o) => client.stream(o),
        ask,
        onEvent: () => {},
      }).finally(close),
  }
}

// ---------- 场景 1: 常规回环 ----------

const scenario1: Scenario = {
  name: "write 回环",
  toolCalls: (msgs) => {
    const user = msgs.find((m) => m.role === "user")?.content ?? ""
    if (user.includes("创建文件")) {
      return [{ name: "write", args: JSON.stringify({ path: "/tmp/minicode-smoke-1.txt", content: "hello mini" }) }]
    }
    return undefined
  },
  finalText: (msgs) => {
    const toolMsg = msgs.at(-1)
    return `完成, 工具结果: ${(toolMsg as ChatMessage).content}`
  },
}

// ---------- 场景 2: 死循环 ----------

const scenario2: Scenario = {
  name: "doom-loop",
  doom: true,
  toolCalls: () => [{ name: "read", args: JSON.stringify({ path: "/tmp/minicode-smoke-2.txt" }) }],
  finalText: () => "unreachable",
}

// ---------- 场景 3: 坏参数 JSON ----------

const scenario3: Scenario = {
  name: "坏参数",
  toolCalls: (msgs) => {
    const user = msgs.find((m) => m.role === "user")?.content ?? ""
    if (user.includes("坏参数")) return [{ name: "read", args: "{not-json" }]
    return undefined
  },
  finalText: (msgs) => `收到: ${(msgs.at(-1) as ChatMessage).content}`,
}

// ---------- 场景 4: 权限拒绝 ----------

const scenario4: Scenario = {
  name: "权限拒绝",
  toolCalls: (msgs) => {
    const user = msgs.find((m) => m.role === "user")?.content ?? ""
    if (user.includes("删除")) return [{ name: "edit", args: JSON.stringify({ path: "/tmp/minicode-smoke-4.txt", oldString: "x", newString: "y" }) }]
    return undefined
  },
  finalText: (msgs) => `结论: ${(msgs.at(-1) as ChatMessage).content}`,
}

async function main(): Promise<void> {
  console.log("MiniCode smoke")

  // 场景 1: write 被调用 → 工具结果回喂 → 模型给出最终文本
  {
    const s = await runScenario(scenario1, "请创建文件 /tmp/minicode-smoke-1.txt 内容为 hello mini")
    const result = await s.run()
    check("回环完成 finish=stop", result.finish === "stop", JSON.stringify(result.finish))
    check(
      "包含 write 工具回执",
      result.messages.some((m) => m.role === "tool" && m.content.includes("已写入")),
      JSON.stringify(result.messages.filter((m) => m.role === "tool")),
    )
    const last = result.messages.at(-1)
    check(
      "最终文本引用工具结果",
      last?.role === "assistant" && last.content.includes("已写入"),
      JSON.stringify(last),
    )
    check("steps=2", result.steps === 2, `steps=${result.steps}`)
  }

  // 场景 2: 死循环在 3 次同参数调用后被中止
  {
    const s = await runScenario(scenario2, "read 循环")
    const result = await s.run()
    check("doom-loop 触发", result.finish === "doom_loop", JSON.stringify(result.finish))
  }

  // 场景 3: 坏参数 JSON → 参数解析失败消息回喂
  {
    const s = await runScenario(scenario3, "坏参数")
    const result = await s.run()
    check("finish=stop", result.finish === "stop", JSON.stringify(result.finish))
    check(
      "参数解析失败被回喂",
      result.messages.some((m) => m.role === "tool" && m.content.includes("参数解析失败")),
      JSON.stringify(result.messages.filter((m) => m.role === "tool")),
    )
  }

  // 场景 4: edit 被用户拒绝 → 工具错误回喂, 无副作用
  {
    const s = await runScenario(scenario4, "删除内容", () => Promise.resolve(false))
    const result = await s.run()
    check(
      "权限拒绝被回喂",
      result.messages.some((m) => m.role === "tool" && m.content.includes("用户拒绝")),
      JSON.stringify(result.messages.filter((m) => m.role === "tool")),
    )
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})