// 新模块单元测试: 视口窗口计算 / 命令注册表 / @引用与!shell 解析
// 运行: pnpm exec tsx test/ui-utils.ts

import { strict as assert } from "node:assert"
import { computeWindow, clampOffset, totalHeight, estimateMsgHeight, estimateMarkdownHeight } from "../src/ui/viewport.tsx"
import { COMMANDS, LEADER_KEYS, matchCommands, helpLines, transcriptName } from "../src/commands.ts"
import { extractAtRefs, scoreMatch, resolveRefs, matchAtCompletion, getFileIndex } from "../src/refs.ts"
import { normalizeSpec } from "../src/influx/plan-runner.ts"

let pass = 0
let fail = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.error(`  ✗ ${name}: ${String(e)}`)
  }
}

// ---------- viewport ----------

check("computeWindow 窗口切片(超长内容贴底)", () => {
  const heights = [2, 3, 4, 5, 6]
  // 视口 8 行, 贴底 offset = 20-8 = 12 → 窗口从第 3 块中部开始
  const w = computeWindow(heights, 8, 12)
  assert.equal(w.start, 3)
  assert.ok(w.startPad >= 0 && w.startPad < heights[3]!)
  assert.ok(w.visibleH <= 8 - w.startPad)
})

check("computeWindow 短内容不滚动", () => {
  const w = computeWindow([2, 3], 20, 100)
  assert.equal(w.start, 0)
  assert.equal(w.end, 2)
  assert.equal(w.startPad, 0)
})

check("clampOffset 收敛", () => {
  assert.equal(clampOffset(-5, 10, [2, 3]), 0)
  assert.equal(clampOffset(999, 10, [2, 3]), 0) // 内容比视口矮
  assert.equal(clampOffset(999, 4, [2, 3]), 1) // 超长: max = 5-4 = 1
})

check("estimateMarkdownHeight 代码块逐行", () => {
  assert.equal(estimateMarkdownHeight("```\na\nb\nc\n```", 40), 5)
})

check("estimateMarkdownHeight 长行换行", () => {
  const h = estimateMarkdownHeight("x".repeat(80), 40)
  assert.equal(h, 2)
})

check("estimateMsgHeight user 头部+正文", () => {
  const m = { kind: "user", text: "hello", ts: 1 } as never
  assert.equal(estimateMsgHeight(m, 40), 2)
})

// ---------- commands ----------

check("matchCommands 前缀匹配", () => {
  const c = matchCommands("/pl")
  assert.ok(c.some((x) => x.name === "plan"))
  assert.equal(matchCommands("普通文本").length, 0)
})

check("matchCommands 别名", () => {
  assert.ok(matchCommands("/cle").some((x) => x.name === "new"))
  assert.ok(matchCommands("/q").some((x) => x.name === "quit"))
})

check("LEADER_KEYS 映射完整", () => {
  for (const k of ["u", "r", "n", "l", "t", "m", "e", "c", "d", "q"]) {
    assert.ok(LEADER_KEYS[k], `leader key ${k}`)
  }
  assert.ok(helpLines().length >= COMMANDS.length)
})

check("transcriptName 时间戳格式", () => {
  assert.match(transcriptName(), /^transcript-\d{8}-\d{6}\.md$/)
})

// ---------- refs ----------

check("extractAtRefs", () => {
  assert.deepEqual(extractAtRefs("看下 @src/foo.ts 和 @bar.ts"), ["src/foo.ts", "bar.ts"])
  assert.deepEqual(extractAtRefs("没有引用"), [])
})

check("scoreMatch 前缀加分/子序列", () => {
  assert.ok(scoreMatch("app.tsx", "app") > scoreMatch("src/happ.ts", "app"))
  assert.equal(scoreMatch("abc", "xyz"), -1)
})

check("resolveRefs 直接路径注入内容", async () => {
  const fs = await import("node:fs")
  const { mkdtempSync } = await import("node:fs")
  const dir = mkdtempSync("/tmp/minicode-refs-")
  fs.writeFileSync(`${dir}/hello.md`, "引用内容", "utf8")
  const r = await resolveRefs(dir, "读 @hello.md 然后总结")
  assert.equal(r.text, "读 hello.md 然后总结")
  assert.equal(r.refs.length, 1)
  assert.ok(r.refs[0]!.content.includes("引用内容"))
})

check("matchAtCompletion 命中未追踪文件(glob 兜底)", async () => {
  const fs = await import("node:fs")
  const { mkdtempSync } = await import("node:fs")
  const dir = mkdtempSync("/tmp/minicode-at-")
  fs.writeFileSync(`${dir}/target-api.ts`, "x", "utf8")
  fs.mkdirSync(`${dir}/sub`)
  fs.writeFileSync(`${dir}/sub/target-helper.ts`, "x", "utf8")
  const r = await matchAtCompletion(dir, "target-api")
  assert.ok(r.includes("target-api.ts"), `候选含 target-api.ts: ${r.join(",")}`)
  const idx = await getFileIndex(dir)
  assert.ok(idx.includes("sub/target-helper.ts"), "索引含子目录文件")
})

// ---------- 声明归一化(shell 参数名漂移容错) ----------

check("normalizeSpec shell 参数名漂移 → cmd", () => {
  const s = normalizeSpec({ type: "flow", children: [{ type: "task", key: "a", tool: "shell", params: { command: "npm test" } }] }) as any
  assert.equal(s.children[0].params.cmd, "npm test")
})

check("normalizeSpec script/cmdline 别名", () => {
  const a = normalizeSpec({ type: "task", key: "b", tool: "shell", params: { script: "echo hi" } }) as any
  assert.equal(a.params.cmd, "echo hi")
  const c = normalizeSpec({ type: "task", key: "c", tool: "shell", params: { cmdline: "ls" } }) as any
  assert.equal(c.params.cmd, "ls")
})

check("normalizeSpec 空 cmd 回退别名", () => {
  const s = normalizeSpec({ type: "task", key: "a", tool: "shell", params: { cmd: "", command: "echo ok" } }) as any
  assert.equal(s.params.cmd, "echo ok")
  const n = normalizeSpec({ type: "task", key: "b", tool: "shell", params: { cmd: "", script: "" } }) as any
  assert.equal(n.params.cmd, "") // 别名也空 → 保持原样, 交给工具报错
})

check("normalizeSpec 不改正确参数与嵌套", () => {
  const s = normalizeSpec({
    type: "flow",
    children: [
      { type: "task", key: "ok", tool: "shell", params: { cmd: "echo ok" } },
      { type: "flow", children: [{ type: "task", key: "d", tool: "http.get", params: { uri: "https://x" } }] },
    ],
  }) as any
  assert.equal(s.children[0].params.cmd, "echo ok")
  assert.equal(s.children[1].children[0].params.url, "https://x")
})

// ---------- 收尾 ----------

console.log(`\nUI utils: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
