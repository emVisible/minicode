/** @jsx task */
// 演示: 并行远端 API 调用 + 聚合 + 条件分支(计划函数随状态重渲染) + 增量重跑
// 远端 API 通过 host 注入的 API_URL / API_KEY 环境变量读取, 未配置时回退 httpbin.org

import { task, Task, Flow } from "../src/influx/core.ts"
import { registerTool } from "../src/influx/tools.ts"

const BASE = process.env.API_URL || "https://httpbingo.org"
const AUTH = process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : {}

registerTool("sum", async (params, ctx) => {
  const total = (params.deps as string[])
    .map((k) => {
      const v = (ctx.results[k] as any)?.body?.args?.v
      return Number(Array.isArray(v) ? v[0] : v)
    })
    .reduce((a, b) => a + b, 0)
  return { total, threshold: 5 }
})

export default function Demo(store: any) {
  const sum = store.get("sum")
  const total = sum?.total ?? 0
  return (
    <Flow key="demo">
      <Task tool="http.get" key="a" url={`${BASE}/anything?v=3`} headers={AUTH} />
      <Task tool="http.get" key="b" url={`${BASE}/anything?v=2`} headers={AUTH} />
      <Task tool="http.get" key="c" url={`${BASE}/anything?v=1`} headers={AUTH} />
      <Task tool="sum" key="sum" dependsOn={["a", "b", "c"]} />
      {sum &&
        (total > 5 ? (
          <Task tool="shell" key="pass" cmd={`echo PASSED: total=${total}`} dependsOn={["sum"]} />
        ) : (
          <Task tool="shell" key="fail" cmd={`echo FAILED: total=${total}`} dependsOn={["sum"]} />
        ))}
    </Flow>
  )
}
