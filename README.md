# MiniCode

Mini opencode: 一个终端里的对话式编码 agent + 内嵌 Influx 声明式计划运行时。零第三方运行时依赖(仅 UI 用 Ink、MCP 用官方 SDK),自写 OpenAI Chat Completions SSE 流式客户端与 tool-call 回环。

设计参考 opencode([anomalyco/opencode](https://github.com/anomalyco/opencode)) 的会话/工具/循环架构,做最小裁剪。原 [Influx](../Influx) 项目(声明式批处理运行时)已并入本仓库 `src/influx/`,统一入口与工具层:

- **对话侧**: `runAgent` 直线循环,LLM 决定调哪些工具,逐轮回环直到收敛
- **计划侧**: 声明式计划树(fiber),reconcile diff + 波次并行执行 + 增量缓存 + 错误阻断

两者共用 `LLM_URL` / `LLM_API_KEY` / `LLM_MODEL` 环境变量;agent 工具集里直接桥接了计划的 `http_get` / `http_post` / `llm` 节点工具。

## 已实现(v0.4)

### 对话 agent

- **LLM 流式客户端**(`src/llm.ts`): SSE 解析 `content`/`tool_calls` delta,超时/退避重试/AbortSignal 中断,API 兼容 OpenAI Chat Completions
- **Agent 循环**(`src/loop.ts`): 请求 → 解析 tool-call → **并行执行** → 回喂结果 → 重发,直到模型不再调用工具;dead-loop 保护(同工具同参数 ≥3 次中止);最多 30 轮
- **上下文压缩**: 单次请求体积超 128KB 时丢弃最旧消息并注入截断标记(摘要化压缩见路线图 W2)
- **内置工具**(`src/tools.ts`): `read` / `write` / `edit` / `glob` / `grep` / `bash` / `http_get` / `http_post` / `llm`
  - 读类( read / glob / grep / http_get / http_post )默认放行;写类(write / edit)与命令(bash)触发确认(并行多工具时逐个排队确认)
  - 输出截断( read 50KB / bash 4000 字符 / grep 200 条 )
- **界面**: 交互式 Ink TUI(输入框、流式文本渲染、工具调用状态、权限确认队列、Esc 中断),以及 headless 模式(管道/stdin 单轮,TTY 下可交互确认)
- **终结条件**: stop(完成) / aborted(用户中断) / max_steps / doom_loop

### Influx 计划运行时(`src/influx/`)

- **运行时**(`core.ts`): mini-react 架构语义移植 — render(计划→fiber 任务树) → reconcile(与上一轮快照 diff: placement/update/skip) → commit(就绪前沿并行执行工具,统一提交结果) → 重规划(计划函数随状态重渲染,直到稳定)
- **内置节点工具**(`tools.ts`): `http.get` / `http.post` / `shell` / `write-file` / `read-file` / `list-dir` / `llm`;计划文件可 `registerTool` 注册自定义工具
  - **`llm` 节点支持 agent 模式**: 传 `tools` 数组(如 `["read", "bash"]`)则节点内跑完整 tool-call 回环(计划内嵌对话),返回 `{answer, steps, finish}`;不传则单问返回 `{answer}`。与对话侧共用同一 `LLMClient`
  - **反向桥接**: 对话工具以 `agent.read` / `agent.write` / `agent.edit` / `agent.bash` / `agent.glob` / `agent.grep` 注册进计划注册表,计划节点可直接使用(见 `examples/agent-demo.plan.tsx`)
- **计划语言**: TSX + `/** @jsx task */` pragma(见 `examples/*.plan.tsx`),支持 `$key.path` 值引用、`when` 条件表达式、`dependsOn` 依赖、`fallback` 兜底、`retries` 重试
- **增量缓存**: 参数未变的节点缓存命中,仅重跑变化分支;`--rerun` 可验证
- **MCP 服务器**(`mcp.ts`): `influx_tools` / `influx_plan`(干跑预览) / `influx_run` / `influx_state` / `influx_result` / `influx_reset`,把编排能力暴露给外部 agent
- **浏览器可视化**(`plan view`): 实时展示任务树与波次执行(SSE)

## 使用

```
pnpm dev                                    # 交互 TUI
pnpm headless -- "列出当前目录文件"          # headless 单轮(写/bash 默认拒绝, 加 --yes 放行)
echo "把 package.json 的 name 改为 x" | pnpm headless -- --yes

pnpm demo                                   # 计划: 并行 HTTP + 聚合 + 条件分支(需外网或注入 API_URL)
pnpm demo:rerun                             # 增量重跑验证(应全部缓存命中)
pnpm demo:serial                            # 串行模式对比
pnpm demo:shell / pnpm demo:fs              # 其他示例计划
pnpm demo:llm                               # llm 单问节点链(需 LLM_URL)
pnpm demo:agent                             # 计划内嵌对话: llm 节点 agent 模式(需 LLM_URL)
pnpm bench                                  # 串行 vs 并行基准
pnpm webui                                  # 浏览器可视化执行过程

pnpm mcp                                    # 启动 MCP 服务器(stdin/stdout)
pnpm smoke                                  # 对话侧端到端冒烟(假 LLM server)
pnpm smoke:influx                           # 计划侧 MCP 冒烟(缓存/阻断/fallback/retry/when)
pnpm typecheck                              # tsc 双配置: 应用 + 计划文件
```

计划子命令(也兼容旧 influx 风格,`minicode run <plan.tsx>`):

```
minicode plan run <plan.tsx>    [--serial] [--rerun] [--max-iter=N]
minicode plan bench <plan.tsx>  [--max-iter=N]
minicode plan view <plan.tsx>   [--serial] [--max-iter=N] [--no-open]
```

环境变量:

```
LLM_URL=/chat/completions 兼容端点(必填)
LLM_API_KEY=可选 Bearer 密钥
LLM_MODEL=默认 "gpt-4o-mini"
```

## 架构

```
src/
  types.ts           单一真相源类型(消息/工具/事件)
  llm.ts             SSE 流式客户端(零网络库, 自解析)
  loop.ts            Agent 主循环(与 UI 解耦, 事件回调)
  tools.ts           对话工具注册(含 influx 桥接 http_get/http_post/llm)
  prompt.ts          系统提示词
  ui/app.tsx         Ink TUI(消费 loop 事件)
  ui/react-jsx.d.ts  全局 JSX shim(根 tsconfig 用 jsx preserve, 桥接 React.JSX)
  cli.ts             统一入口(TUI / headless / plan / mcp)
  influx/
    core.ts          Influx 运行时(fiber + reconcile + 波次并行 + 缓存)
    tools.ts         计划节点工具注册表
    agent-loop.ts    llm 节点 agent 模式: 计划内嵌对话(runAgent 回环)
    agent-tools.ts   反向桥接: 对话工具 → 计划注册表(agent.*)
    plan-cli.ts      plan run/bench/view 实现(可调用模块)
    mcp.ts           MCP 服务器
    jsx.d.ts         计划文件 JSX 类型
    view.html        可视化面板
examples/            *.plan.tsx 示例计划(TSX 声明式)
test/smoke.ts        对话侧脚本化假 LLM server 驱动全链路
test/influx-smoke.ts 计划侧 MCP 冒烟
```

## JSX 双轨说明

根 tsconfig 使用 `"jsx": "preserve"`(经典工厂):计划文件靠文件头 `/** @jsx task */` pragma 编译成 `task()` 调用,React 组件靠 `import React from "react"` 提供 `React.createElement`。类型检查分两个程序,避免全局 JSX 命名空间冲突:

- `tsconfig.json`(应用 + 测试): 全局 JSX 由 `src/ui/react-jsx.d.ts` 桥接 `React.JSX`
- `tsconfig.plans.json`(示例计划): 全局 JSX 由 `src/influx/jsx.d.ts` 提供,不引入 React 类型

## 验证门禁

`pnpm typecheck && pnpm smoke && pnpm smoke:influx` 必须全绿。smoke 覆盖: 工具回环、回喂、doom-loop、坏参 JSON、权限拒绝;influx smoke 覆盖: 干跑预览、缓存命中、when 分支、错误阻断、fallback、retry、自动 key、重复 key 快速失败、llm 节点 agent 模式(tool_calls 回环)。

## 未实现(明确不做/后续)

- 上下文**摘要化**压缩(当前为体积截断,不做语义摘要)
- 会话持久化、多轮跨进程恢复
- 子 agent / MCP client / 插件
- 图片输入、多 provider 协议(non-OpenAI)
- 计划运行时与对话 agent 的深度统一(当前共用 CLI/环境变量/工具桥接,两套循环各自独立;计划内嵌对话已打通单点)

> 诚实说明: 真实 LLM 端到端未经当前环境验证(无 LLM_URL 配置)。smoke 用脚本化假 server 验证了协议与循环逻辑(含 llm 节点 agent 模式的 tool_calls 回环);接入真实模型需按上文配置环境后人工验证。
