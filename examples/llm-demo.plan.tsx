/** @jsx task */
// 演示: LLM 智能节点链 —— llm 生成 → write-file 落盘 → read-file 回读 → shell 展示
// 前提: host 环境注入 LLM_URL(+ 可选 LLM_API_KEY / LLM_MODEL), 或给节点显式传 url / model
// 若 LLM 节点失败, 下游整条链被 blocked(错误阻断语义)
// 输出目录: 项目根 .out/llm-demo(可用 INFLUX_DEMO_OUT 覆盖)

import { task, Task, Flow } from "../src/influx/core.ts"
import { join } from "node:path"

const OUT = process.env.INFLUX_DEMO_OUT ?? join(process.cwd(), ".out", "llm-demo")

export default function LlmDemo() {
  return (
    <Flow key="llm-demo">
      <Task
        tool="llm"
        key="slogan"
        system="你是技术写作助手, 输出简洁中文, 不要多余解释"
        prompt="为 influx(一个基于 fiber 计划树与增量缓存的 agent 编排运行时)写 3 条 slogan, 每行一条"
      />
      <Task
        tool="write-file"
        key="write"
        path={join(OUT, "slogans.md")}
        content={"# slogans\n\n{$slogan.answer}"}
        dependsOn={["slogan"]}
      />
      <Task tool="read-file" key="verify" path={join(OUT, "slogans.md")} dependsOn={["write"]} />
      <Task tool="shell" key="show" cmd={"cat " + join(OUT, "slogans.md")} dependsOn={["verify"]} />
    </Flow>
  )
}
