# MiniCode

Mini opencode: 一个终端里的对话式编码 agent + 内嵌 Influx 声明式计划运行时。零第三方运行时依赖(仅 UI 用 Ink、MCP 用官方 SDK),自写 OpenAI Chat Completions SSE 流式客户端与 tool-call 回环。

设计参考 opencode([anomalyco/opencode](https://github.com/anomalyco/opencode)) 的会话/工具/循环架构,做最小裁剪。原 [Influx](../Influx) 项目(声明式批处理运行时)已并入本仓库 `src/influx/`,统一入口与工具层:

- **对话侧**: `runAgent` 直线循环,LLM 决定调哪些工具,逐轮回环直到收敛
- **计划侧**: 声明式计划树(fiber),reconcile diff + 波次并行执行 + 增量缓存 + 错误阻断

两者共用 `LLM_URL` / `LLM_API_KEY` / `LLM_MODEL` 环境变量;agent 工具集里直接桥接了计划的 `http_get` / `http_post` / `llm` 节点工具。

## 已实现(v0.4)

### 对话 agent

- **LLM 流式客户端**(`src/llm.ts`): SSE 解析 `content`/`tool_calls` delta,超时/退避重试/AbortSignal 中断,API 兼容 OpenAI Chat Completions
- **Agent 循环**(`src/loop.ts`): 请求 → 解析 tool-call → **并行执行**(同一回复内的多个独立工具调用同时运行) → 回喂结果 → 重发,直到模型不再调用工具;dead-loop 保护(同工具同参数 ≥3 次中止);最多 30 轮
  - 系统提示词明确引导模型一次发出多个无依赖的工具调用
  - 执行按**波次**(树的同一层)推进: 每轮回复的 tool_calls 是兄弟节点, 并行执行, 波次间串行
  - 验证: smoke 场景 5 断言 2 个 sleep 1 并行完成(1.02s, 串行为 2s)
- **上下文压缩**: 单次请求体积超 128KB 时丢弃最旧消息并注入截断标记(摘要化压缩见路线图 W2)
- **内置工具**(`src/tools.ts`): `read` / `write` / `edit` / `glob` / `grep` / `bash` / `http_get` / `http_post` / `llm`
  - 读类( read / glob / grep / http_get / http_post )默认放行;写类(write / edit)与命令(bash)触发确认(并行多工具时逐个排队确认)
  - 输出截断( read 50KB / bash 4000 字符 / grep 200 条 )
- **界面**: 交互式 Ink TUI(输入框、权限确认队列[输入框保持可用, 输入 y 放行]、Esc 中断),以及 headless 模式(管道/stdin 单轮,TTY 下可交互确认)
  - **打字机流式渲染**: SSE delta 进入打字机队列, 每 16ms 单字吐出(积压时小幅加速), 感知"逐字打出"而非分块涌入; 渲染只更新短字符串, 不触碰对话数组
  - **Markdown 渲染**(`src/ui/markdown.tsx`): 标题(#)粗体青色、列表(•/1.)、代码块(``` 圆角边框)、引用(│)、行内 `code` 青色、**粗体**; 对话流与流式文本均支持
  - **启动欢迎卡片**(`src/ui/welcome.tsx`): 圆角边框信息面板 —— 目录/模型/工具数/快捷键速查, 首条消息前展示
  - **对话分隔符**: 角色切换时插入 `─── 你 ───` / `─── MiniCode ───` / `─── 工具 ───`, 单 session 多轮一目了然
  - **组合式布局**: 左对话流 + 右任务树侧边栏, 各组件独立负责、组合拼接
  - **任务树视图**: 对话执行渲染为树 —— 用户消息(根)→ 每轮波次(分支)→ 工具调用(同层兄弟=并行),状态符号 ○/◐/✓/✗ + 颜色区分,并行波次标注 `波次 N · M 并行`,执行过程"看得见"
  - **`/plan <任务>`**: 让 LLM 把任务拆解为 DAG 计划, 交给 Influx 运行时**全并行执行**(无依赖节点同波并行, 依赖链自动串行) —— 对话理解 + 计划执行的"1+1>2"
  - **`/vbuild <任务>` 两段式构建(VBuild → RBuild)**: 所有 write/edit 先进内存 overlay(VBuild, 虚拟文件系统 `src/vfs.ts`), 全程零磁盘副作用; 完成后展示 diff(+ 新建 / ~ 修改 / − 删除), 输入 y 才 **RBuild 并行批量落盘**, 输入 n 丢弃(可回滚)。`/plan` 同样走两段式
  - 流式渲染独立于对话流(不触碰 lines 数组), 状态栏实时显示吞吐 `Nc/s`; 流式响应 60s 无数据自动报错(服务器挂起检测)
  - **内置设置面板**: TUI 内 `Ctrl+o`(或 `/config`)呼出,配置 LLM URL / API Key / Model,Enter 保存即生效并持久化到 `~/.minicode/config.json`(0600 权限,原子写);环境变量优先于配置文件
- **双引擎自动分流**: 每条消息先尝试由 LLM 拆解为 Influx DAG(1 次快速调用), ≥2 个可并行节点 → 自动走 Influx 全并行执行(波次调度); 拆解失败/纯问答 → 回退对话循环。默认路径就吃上 Influx 并行能力, 无需手动 `/plan`
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

环境变量(也可在 TUI 设置面板中配置,保存到 `~/.minicode/config.json`):

```
LLM_URL=/chat/completions 兼容端点(必填)
LLM_API_KEY=可选 Bearer 密钥
LLM_MODEL=默认 "gpt-4o-mini"
```

## 架构

```
src/
  types.ts           单一真相源类型(消息/工具/事件)
  config.ts          用户配置(~/.minicode/config.json, 原子写/防御加载/0600)
  llm.ts             SSE 流式客户端(零网络库, 自解析, idle 超时/tps 统计)
  loop.ts            Agent 主循环(与 UI 解耦, 事件回调)
  vfs.ts             虚拟文件系统(VBuild/RBuild 两段式构建核心)
  tools.ts           对话工具注册(含 influx 桥接 http_get/http_post/llm)
  prompt.ts          系统提示词
  ui/app.tsx         Ink TUI(消费 loop 事件)
  ui/settings.tsx    设置面板(Ctrl+o 呼出)
  ui/tree.tsx        任务树视图(波次并行可视化)
  ui/react-jsx.d.ts  全局 JSX shim(根 tsconfig 用 jsx preserve, 桥接 React.JSX)
  cli.ts             统一入口(TUI / headless / plan / mcp)
  influx/
    core.ts          Influx 运行时(fiber + reconcile + 波次并行 + 缓存)
    tools.ts         计划节点工具注册表
    agent-loop.ts    llm 节点 agent 模式: 计划内嵌对话(runAgent 回环)
    agent-tools.ts   反向桥接: 对话工具 → 计划注册表(agent.*)
    plan-runner.ts   对话内全并行执行(/plan: LLM 生成 DAG → Runtime 全并行)
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
