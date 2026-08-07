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

// ---------- 场景 5: 并行工具调用 ----------
// 一次返回 2 个 sleep 1 的 bash 调用: 并行应 ~1s, 串行会 ~2s

const scenario5: Scenario = {
  name: "并行工具",
  toolCalls: (msgs) => {
    const user = msgs.find((m) => m.role === "user")?.content ?? ""
    if (user.includes("并行")) {
      return [
        { name: "bash", args: JSON.stringify({ cmd: "sleep 1" }) },
        { name: "bash", args: JSON.stringify({ cmd: "sleep 1" }) },
      ]
    }
    return undefined
  },
  finalText: (msgs) => {
    const toolMsgs = msgs.filter((m) => m.role === "tool")
    return `完成, ${toolMsgs.length} 条回执`
  },
}

async function main(): Promise<void> {
  console.log("MiniCode smoke")

  // 配置模块: 原子写(0600) / 往返 / env 注入 / env 优先 / 损坏回退
  {
    const { mkdtempSync, writeFileSync, rmSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "minicode-cfg-"))
    const orig = process.env.MINICODE_CONFIG
    process.env.MINICODE_CONFIG = join(dir, "config.json")
    const { loadConfig, saveConfig, applyConfigToEnv } = await import("../src/config.ts")
    saveConfig({ llmUrl: "https://api.example.com/v1", llmApiKey: "sk-test", llmModel: "test-model" })
    const mode = (statSync(process.env.MINICODE_CONFIG).mode & 0o777).toString(8)
    check("配置原子写 0600", mode === "600", `mode=${mode}`)
    const cfg = loadConfig()
    check(
      "配置往返一致",
      cfg.llmUrl === "https://api.example.com/v1" && cfg.llmApiKey === "sk-test" && cfg.llmModel === "test-model",
      JSON.stringify(cfg),
    )
    delete process.env.LLM_URL
    delete process.env.LLM_MODEL
    applyConfigToEnv(cfg)
    check("配置注入 env", process.env.LLM_URL === "https://api.example.com/v1" && process.env.LLM_MODEL === "test-model")
    process.env.LLM_MODEL = "manual-model"
    applyConfigToEnv(cfg)
    check("env 优先于配置", process.env.LLM_MODEL === "manual-model", `model=${process.env.LLM_MODEL}`)
    writeFileSync(process.env.MINICODE_CONFIG, "{broken", "utf8")
    check("损坏配置回退空", JSON.stringify(loadConfig()) === "{}")
    if (orig !== undefined) process.env.MINICODE_CONFIG = orig
    else delete process.env.MINICODE_CONFIG
    delete process.env.LLM_URL
    delete process.env.LLM_MODEL
    rmSync(dir, { recursive: true, force: true })
  }

  // 场景 0: /plan 全并行 — 假 LLM 返回 DAG, 3 独立节点同波并行, 依赖链正确
  {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "smoke-plan-"))
    const spec = {
      type: "flow",
      key: "root",
      children: [
        { type: "task", key: "s1", tool: "shell", params: { cmd: "sleep 0.3" } },
        { type: "task", key: "s2", tool: "shell", params: { cmd: "sleep 0.3" } },
        { type: "task", key: "s3", tool: "shell", params: { cmd: "sleep 0.3" } },
        {
          type: "task",
          key: "w",
          tool: "write-file",
          params: { path: join(dir, "o.txt"), content: "x={$s1.stdout}" },
          dependsOn: ["s1"],
        },
        { type: "task", key: "r", tool: "read-file", params: { path: join(dir, "o.txt") }, dependsOn: ["w"] },
      ],
    }
    const planSrv = createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(spec) } }] }))
      })
    })
    await new Promise<void>((r) => planSrv.listen(0, r))
    const planPort = (planSrv.address() as any).port
    const { runPlannedTask } = await import("../src/influx/plan-runner.ts")
    const nodeWaves = new Map<string, number>()
    const nodeStart = new Map<string, number>()
    const nodeEnd = new Map<string, number>()
    let curWave = 0
    let seq = 0
    const t0 = performance.now()
    const pr = await runPlannedTask("smoke", {
      url: `http://127.0.0.1:${planPort}/v1/chat/completions`,
      onEvent: (e) => {
        if (e.type === "wave-start") curWave = e.n
        if (e.type === "node-start" && e.key !== "root") {
          seq++
          nodeStart.set(e.key, seq)
          nodeWaves.set(e.key, curWave)
        }
        if (e.type === "node-end" && e.key !== "root") nodeEnd.set(e.key, seq++)
      },
    })
    const elapsed = performance.now() - t0
    planSrv.close()
    rmSync(dir, { recursive: true, force: true })
    const s1 = nodeWaves.get("s1")!
    check("plan: 3 独立节点同波并行", s1 === nodeWaves.get("s2") && s1 === nodeWaves.get("s3"))
    // 事件驱动调度: 依赖链用"启动顺序"断言(w 在 s1 完成后才启动, r 在 w 完成后才启动)
    check(
      "plan: 依赖链 w 在 s1 完成后启动",
      (nodeStart.get("w") ?? 0) > (nodeEnd.get("s1") ?? 0) && (nodeStart.get("w") ?? 0) > (nodeStart.get("s2") ?? 0),
    )
    check("plan: 依赖链 r 在 w 完成后启动", (nodeStart.get("r") ?? 0) > (nodeEnd.get("w") ?? 0))
    check(`plan: 0.3s×3 并行+依赖 <1.6s (${(elapsed / 1000).toFixed(2)}s)`, elapsed < 1600)
    check("plan: 依赖值传递", pr.ok && String((pr.results.r as any)?.content ?? "").includes("x="))
  }

  // 场景 0a: 事件驱动调度核心承诺 — "小兄弟的下游不等大兄弟"。
  // boss 有 3 个子任务: big(0.6s) + small1(0.1s) + small2(0.1s);
  // x 只依赖 small1 → 必须在 big 完成之前启动(波次屏障时代它必须等 big)。
  {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "smoke-edsched-"))
    const { runSpec } = await import("../src/influx/plan-runner.ts")
    const spec = {
      type: "flow", key: "root",
      children: [
        { type: "task", key: "big", tool: "shell", params: { cmd: "sleep 0.6" } },
        { type: "task", key: "sm1", tool: "shell", params: { cmd: "sleep 0.1" } },
        { type: "task", key: "sm2", tool: "shell", params: { cmd: "sleep 0.1" } },
        { type: "task", key: "x", tool: "shell", params: { cmd: "echo ok" }, dependsOn: ["sm1"] },
      ],
    }
    const order: string[] = []
    const rep = await runSpec(spec, {
      cwd: dir,
      onEvent: (e) => {
        if (e.type === "node-start") order.push(`s:${e.key}`)
        if (e.type === "node-end") order.push(`e:${e.key}`)
      },
    })
    check("edsched: 无错误", Object.keys(rep.errors).length === 0, JSON.stringify(rep.errors))
    check(
      "edsched: x 在 big 完成前启动(不等大兄弟)",
      order.indexOf("s:x") < order.indexOf("e:big"),
      order.join(" "),
    )
    check("edsched: x 在 sm1 完成后启动(依赖仍需满足)", order.indexOf("s:x") > order.indexOf("e:sm1"))
    rmSync(dir, { recursive: true, force: true })
  }

  // 场景 0b: VFS 两段式构建 — VBuild 写 overlay 磁盘不动, diff 正确, RBuild commit 落盘
  {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "smoke-vfs-"))
    const aPath = join(dir, "a.txt")
    const bPath = join(dir, "b.txt")
    writeFileSync(aPath, "hello", "utf8")
    writeFileSync(bPath, "bye", "utf8")
    const { VFS } = await import("../src/vfs.ts")
    const vfs = new VFS(dir)
    vfs.write(join(dir, "new.txt"), "new content")
    vfs.write(aPath, "hello world")
    vfs.remove(bPath)
    check("VFS: VBuild 写 overlay 磁盘不动", readFileSync(aPath, "utf8") === "hello" && !existsSync(join(dir, "new.txt")))
    const kinds = vfs.diff().map((c) => c.kind)
    check("VFS: diff 分类 create/modify/delete", kinds.includes("create") && kinds.includes("modify") && kinds.includes("delete"))
    await vfs.commit()
    check(
      "VFS: RBuild 落盘(新建/修改/删除)",
      readFileSync(join(dir, "new.txt"), "utf8") === "new content" &&
        readFileSync(aPath, "utf8") === "hello world" &&
        !existsSync(bPath),
    )
    const vfs2 = new VFS(dir)
    vfs2.write(join(dir, "roll.txt"), "x")
    vfs2.rollback()
    check("VFS: rollback 丢弃", !vfs2.hasChanges() && !existsSync(join(dir, "roll.txt")))
    rmSync(dir, { recursive: true, force: true })
  }

  // 场景 0c: 双引擎文件操作 spec — agent.* 工具可用(ensureAgentTools), 无依赖同波并行,
  //          依赖链串行, VBuild 暂存 → RBuild 落盘
  {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "smoke-dual-"))
    writeFileSync(join(dir, "ui.tsx"), "old content", "utf8")
    writeFileSync(join(dir, "a.ts"), "const a = 1", "utf8")
    const { runSpec } = await import("../src/influx/plan-runner.ts")
    const { VFS } = await import("../src/vfs.ts")
    const vfs = new VFS(dir)
    const waves: string[][] = []
    const order: string[] = []
    const spec = {
      type: "flow", key: "root",
      children: [
        { type: "task", key: "g1", tool: "agent.glob", params: { pattern: "**/*.tsx" } },
        { type: "task", key: "s1", tool: "agent.read", params: { path: join(dir, "a.ts") } },
        { type: "task", key: "r1", tool: "agent.read", params: { path: join(dir, "ui.tsx") }, dependsOn: ["g1"] },
        { type: "task", key: "w1", tool: "write-file", params: { path: join(dir, "ui.tsx"), content: "v2:{$r1.output}" }, dependsOn: ["r1"] },
      ],
    }
    const rep = await runSpec(spec, {
      cwd: dir, vfs,
      onEvent: (e) => {
        if (e.type === "wave-start") waves.push([])
        if (e.type === "node-start") {
          waves[waves.length - 1]!.push(e.key)
          order.push(`s:${e.key}`)
        }
        if (e.type === "node-end") order.push(`e:${e.key}`)
      },
    })
    check("dual: agent.* 工具可用且无错误", Object.keys(rep.errors).length === 0, JSON.stringify(rep.errors))
    check("dual: 无依赖节点同波并行", !!(waves[0]?.includes("g1") && waves[0]?.includes("s1")))
    // 事件驱动调度: 依赖链串行 = r1 启动晚于 g1 结束, w1 启动晚于 r1 结束
    check(
      "dual: 依赖链串行(r 在 g 后, w 在 r 后)",
      order.indexOf("s:r1") > order.indexOf("e:g1") && order.indexOf("s:w1") > order.indexOf("e:r1"),
      order.join(" "),
    )
    check("dual: VBuild 暂存磁盘未动", readFileSync(join(dir, "ui.tsx"), "utf8") === "old content" && vfs.hasChanges())
    await vfs.commit()
    check("dual: RBuild 落盘(引用+净化)", readFileSync(join(dir, "ui.tsx"), "utf8") === "v2:old content")
    rmSync(dir, { recursive: true, force: true })
  }

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

  // 场景 2: 死循环在警告后仍未改变时中止(连续 3 次警告, 第 4 次中止)
  {
    const s = await runScenario(scenario2, "read 循环")
    const result = await s.run()
    check("doom-loop 触发", result.finish === "doom_loop", JSON.stringify(result.finish))
  }

  // 场景 2b: 非连续重复(读 A → 写 B → 再读 A)不算死循环, 正常完成
  {
    const s = await runScenario(
      {
        name: "非连续重复",
        toolCalls: (msgs) => {
          const tools = msgs.filter((m) => m.role === "tool")
          if (tools.length < 2) return [{ name: "read", args: JSON.stringify({ path: "/tmp/smoke-a.txt" }) }]
          return [{ name: "write", args: JSON.stringify({ path: "/tmp/smoke-b.txt", content: "b" }) }]
        },
        finalText: (msgs) => {
          const t = msgs.filter((m) => m.role === "tool")
          return `完成, ${t.length} 条回执`
        },
      },
      "修改文件",
    )
    const result = await s.run()
    check("非连续重复不误杀(应 stop)", result.finish === "stop", JSON.stringify(result.finish))
  }

  // 场景 2c: 波次内并行重复参数不累积 —— RBuild 误报回归测试。
  // 模型在并行波次里重复参数(如一步并行 read 同一文件两次)是常见行为,
  // 旧实现按调用计数: [A,A]+[A,A] = 4 → 直接中止; 新实现按整批签名比较,
  // 只有整批与上一批完全一致才 +1, 波次内重复不再累积。
  {
    const s = await runScenario(
      {
        name: "并行重复不误杀",
        doom: true,
        toolCalls: (msgs) => {
          const tools = msgs.filter((m) => m.role === "tool")
          if (tools.length < 4) {
            // 波次 1/2: 并行重复 read(旧实现 2 步即 4 次 → 误杀)
            return [
              { name: "read", args: JSON.stringify({ path: "/tmp/smoke-c.txt" }) },
              { name: "read", args: JSON.stringify({ path: "/tmp/smoke-c.txt" }) },
            ]
          }
          if (tools.length < 6) {
            // 波次 3: 换个调用(重置连续计数)
            return [{ name: "read", args: JSON.stringify({ path: "/tmp/smoke-d.txt" }) }]
          }
          return undefined // 停止
        },
        finalText: () => "完成",
      },
      "并行重复",
    )
    const result = await s.run()
    check("波次内并行重复不误杀(应 stop)", result.finish === "stop", JSON.stringify(result.finish))
  }

  // 场景 2d: 真并行循环仍被捕获 —— 整批签名连续一致 4 波次 → 中止
  {
    const s = await runScenario(
      {
        name: "并行真循环",
        doom: true,
        toolCalls: () => [
          { name: "read", args: JSON.stringify({ path: "/tmp/smoke-e.txt" }) },
          { name: "read", args: JSON.stringify({ path: "/tmp/smoke-e.txt" }) },
        ],
        finalText: () => "unreachable",
      },
      "并行循环",
    )
    const result = await s.run()
    check("真并行循环仍中止(doom_loop)", result.finish === "doom_loop", JSON.stringify(result.finish))
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

  // 场景 5: 一次 2 个 sleep 1 的 bash 调用 → 并行执行(耗时 ~1s 而非 ~2s)
  {
    const s = await runScenario(scenario5, "并行执行两个 sleep")
    const t0 = performance.now()
    const result = await s.run()
    const elapsed = performance.now() - t0
    const toolCount = result.messages.filter((m) => m.role === "tool").length
    check("并行: 2 条工具回执", toolCount === 2, `count=${toolCount}`)
    check(`并行: 耗时 ${(elapsed / 1000).toFixed(2)}s < 1.8s`, elapsed < 1800, `elapsed=${(elapsed / 1000).toFixed(2)}s`)
  }

  // Axiom 基准原则: 动态读取(mtime 失效) + 第一部提取 + 模式控制
  {
    const { writeFileSync, mkdtempSync, rmSync, utimesSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "axiom-"))
    const p = join(dir, "axiom.md")
    const oldPath = process.env.MINICODE_AXIOM_PATH
    const oldMode = process.env.MINICODE_AXIOM
    process.env.MINICODE_AXIOM_PATH = p
    process.env.MINICODE_AXIOM = "core"
    const { axiomPromptBlock, resolveAxiomMode } = await import("../src/axiom.ts")

    // 写入 v1(含第一部/第二部标题)
    writeFileSync(p, "前言\n# 第一部 · 测试版 v1\n第1层: 求真\n# 第二部 · 章程\n内容B\n", "utf8")
    const block1 = axiomPromptBlock()
    check("core 模式提取第一部", block1.includes("测试版 v1") && block1.includes("求真") && !block1.includes("内容B"), block1.slice(0, 80))

    // 更新为 v2(mtime 变化 → 缓存失效 → 新内容)
    const future = new Date(Date.now() + 5000)
    utimesSync(p, future, future)
    writeFileSync(p, "前言\n# 第一部 · 测试版 v2\n第1层: 求真升级\n# 第二部 · 章程\n内容B\n", "utf8")
    utimesSync(p, new Date(future.getTime() + 2000), new Date(future.getTime() + 2000))
    const block2 = axiomPromptBlock()
    check("文档更新后自动读到新版(动态不写死)", block2.includes("测试版 v2") && !block2.includes("测试版 v1"), block2.slice(0, 80))

    // none 模式: 不注入
    process.env.MINICODE_AXIOM = "none"
    check("none 模式不注入", axiomPromptBlock() === "", "")
    check("模式解析", resolveAxiomMode() === "none")

    // 无标题结构 → 回退全文前段
    process.env.MINICODE_AXIOM = "core"
    writeFileSync(p, "没有标题结构的全文内容", "utf8")
    const block3 = axiomPromptBlock()
    check("标题缺失回退全文", block3.includes("没有标题结构"), block3.slice(0, 60))

    // 恢复环境
    if (oldPath === undefined) delete process.env.MINICODE_AXIOM_PATH
    else process.env.MINICODE_AXIOM_PATH = oldPath
    if (oldMode === undefined) delete process.env.MINICODE_AXIOM
    else process.env.MINICODE_AXIOM = oldMode
    rmSync(dir, { recursive: true, force: true })
  }

  // /undo /redo: 快照回滚与重做
  {
    const { writeFileSync, readFileSync, mkdtempSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "undo-"))
    const f = join(dir, "a.txt")
    writeFileSync(f, "original", "utf8")
    const undo = await import("../src/undo.ts")
    undo.newFrame()
    undo.capture(f, "original", "changed")
    writeFileSync(f, "changed", "utf8")
    const r1 = undo.undo()
    check("undo 恢复原文", r1.restored.length === 1 && readFileSync(f, "utf8") === "original", readFileSync(f, "utf8"))
    const r2 = undo.redo()
    check("redo 重放改动", r2.restored.length === 1 && readFileSync(f, "utf8") === "changed", readFileSync(f, "utf8"))
    rmSync(dir, { recursive: true, force: true })
  }

  // 会话持久化: save/list/load 往返
  {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "sess-"))
    const oldHome = process.env.HOME
    process.env.HOME = dir // 重定向 sessions 目录
    const sess = await import("../src/session.ts")
    const id = sess.newSessionId("/tmp/项目X")
    sess.saveSession({
      id,
      cwd: "/tmp/项目X",
      model: "test",
      mode: "build",
      createdAt: Date.now(),
      msgs: [{ kind: "user", text: "你好", ts: Date.now() }],
      history: [{ role: "user", content: "你好" }],
    })
    const list = sess.listSessions()
    check("会话已保存并可列出", list.length >= 1 && list.some((s) => s.id === id && s.firstMsg === "你好"), JSON.stringify(list))
    const loaded = sess.loadSession(id)
    check("会话可恢复(msgs+history)", loaded?.msgs[0]?.kind === "user" && loaded?.history[0]?.content === "你好")
    sess.deleteSession(id)
    check("会话可删除", sess.loadSession(id) === null)
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})