/** @jsx task */
// 演示: 内置文件工具(list-dir / write-file / read-file) + 错误阻断语义
//   wave1: list-dir 扫描 + 一个必失败节点(并行)
//   wave2: 失败节点的下游被 blocked, 独立分支(write→verify→show)不受影响
//   wave3: show 输出写盘结果
// 输出目录: 项目根 .out/fs-demo(可用 INFLUX_DEMO_OUT 覆盖)

import { task, Task, Flow } from "../src/influx/core.ts"
import { join } from "node:path"

const EXAMPLES = join(process.cwd(), "examples")
const OUT = process.env.INFLUX_DEMO_OUT ?? join(process.cwd(), ".out", "fs-demo")

export default function FsDemo() {
  return (
    <Flow key="fs-demo">
      <Task tool="list-dir" key="ls-examples" path={EXAMPLES} />
      <Task tool="shell" key="boom" cmd="exit 1" />
      <Task tool="shell" key="blocked-child" cmd="echo 不应执行" dependsOn={["boom"]} />
      <Task
        tool="write-file"
        key="write"
        path={join(OUT, "report.md")}
        content={"examples 目录共 {$ls-examples.files.length} 个文件"}
        dependsOn={["ls-examples"]}
      />
      <Task tool="read-file" key="verify" path={join(OUT, "report.md")} dependsOn={["write"]} />
      <Task tool="shell" key="show" cmd={"cat " + join(OUT, "report.md")} dependsOn={["verify"]} />
    </Flow>
  )
}
