/** @jsx task */
// 演示: 计划内嵌对话 —— llm 节点 agent 模式在计划内跑完整 tool-call 回环
// 流程: agent 读取 package.json → 用 bash 查 node 版本 → 总结项目技术栈
// 前提: host 环境注入 LLM_URL(+ 可选 LLM_API_KEY / LLM_MODEL), 或给节点显式传 url / model
// 对比 examples/llm-demo.plan.tsx: 那里 llm 只能"问一次", 这里 llm 能调 read/bash 等多步回环

import { task, Task, Flow } from "../src/influx/core.ts"
import { join } from "node:path"

const ROOT = process.cwd()

export default function AgentDemo() {
  return (
    <Flow key="agent-demo">
      <Task
        tool="llm"
        key="probe"
        prompt={`分析 ${join(ROOT, "package.json")} 的技术栈。步骤:
1. 用 read 读取 package.json
2. 用 bash 运行 "node --version && pnpm --version" 获取运行时版本
3. 总结: 项目类型、关键依赖、Node 要求, 用 3 行中文输出`}
        tools={["read", "bash"]}
        maxSteps={10}
      />
      <Task
        tool="write-file"
        key="report"
        path={join(ROOT, ".out", "agent-demo", "stack.md")}
        content={"# 技术栈报告\n\n{$probe.answer}"}
        dependsOn={["probe"]}
      />
      <Task tool="read-file" key="verify" path={join(ROOT, ".out", "agent-demo", "stack.md")} dependsOn={["report"]} />
      <Task tool="shell" key="show" cmd={"cat " + join(ROOT, ".out", "agent-demo", "stack.md")} dependsOn={["verify"]} />
    </Flow>
  )
}
