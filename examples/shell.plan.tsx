/** @jsx task */
// 离线演示: 3 个 shell 任务并行执行 + 汇合节点, 验证并行加速
// 并行 ~1s vs 串行 ~3s

import { task, Task, Flow } from "../src/influx/core.ts"

export default (
  <Flow key="shell">
    <Task tool="shell" key="s1" cmd="sleep 1" />
    <Task tool="shell" key="s2" cmd="sleep 1" />
    <Task tool="shell" key="s3" cmd="sleep 1" />
    <Task tool="shell" key="join" cmd="echo all-done" dependsOn={["s1", "s2", "s3"]} />
  </Flow>
)
