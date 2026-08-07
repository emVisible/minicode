# MiniCode

Mini opencode: 一个终端里的对话式编码 agent + 内嵌 Influx 声明式计划运行时。核心链路(LLM SSE 客户端、tool-call 回环、计划运行时、VFS、TUI)全部自研; 第三方依赖仅限 UI 渲染(Ink/React)、远端请求(undici)、模式校验(zod)与 MCP 官方 SDK。

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
  - **设计原则**(A1-A7): ① 信息分三层永不混层 —— 内容(助手回答)/ 活动(工具执行)/ 系统(诊断)物理隔离;② 单一强调色(淡紫蓝)+ 中性灰阶, 语义色只在"裁定"时出现;③ 层级靠排印(字重/亮度/留白), 不用装饰边框;④ 信息密度自适应 —— 活动面板运行时展开(右 40%), 完成收回, 对话恢复全宽;⑤ 一切可回溯(Ctrl+d 诊断托盘);⑥ 统一间距节奏;⑦ 动效克制(打字机 + 单处 spinner)
  - **主题**(`src/ui/theme.ts`): dark/light 两套设计令牌, 自动检测终端背景(`MINICODE_THEME=dark|light` 显式覆盖 / COLORFGBG / OSC 11 查询, 默认 dark)
  - **打字机流式渲染**: SSE delta 进入打字机队列, 每 16ms 单字吐出(积压时小幅加速), 尾部未完成行以光标块 `▍` 闪烁; 渲染只更新短字符串
  - **Markdown 渲染**(`src/ui/markdown.tsx`): 标题(字重分层,不显示 #)/ 无序·有序·任务·嵌套列表 / **表格**(CJK 全角宽度对齐)/ 代码块(左 rail + 微底色 + JSON/bash/TS 迷你高亮)/ 引用 rail / 分隔线(细发线)/ 行内 `code`、**bold**、*italic*、~~strike~~、链接; 宽度感知(活动面板展开时自动收窄)
  - **启动欢迎卡片**(`src/ui/welcome.tsx`): wordmark + 命令网格, 首条消息前展示
  - **消息呈现**: 用户消息带 `你` 头 + 右对齐时间戳; 助手消息左侧淡紫蓝 rail; 运行结论为单行裁定 `✓ 全并行 3 波 · 2.0s` + 变更明细(dim); 工具事件不再混入对话流
  - **并行执行可视化(过程可见, MiniCode 特色)**: 左侧对话流实时"过程 feed" —— 当前波次(⚡ 波次 N · M 并行 · K 运行中)+ 各节点状态与**运行中节点的流式输出**(llm 生成内容逐块可见); 右侧面板波次/节点带**实时进度条**(▰▱ 填充, 1.5s 走满)+ 已用时长; 状态栏显示 `执行中 · 波次 X/Y`; 完成后 feed 收敛为结论行
  - **活动面板**(`src/ui/activity.tsx`): 运行时右 32% —— 波次 header(⚡ 并行数/✓ 完成数) + 节点行(○/◐/✓/✗ + 进度条 + 耗时); 运行中 Tab 焦点轮回: ↑↓ 选择、Enter 展开/收起节点输出、`e` 全展开、Esc 返回; 完成后收回为对话流内的结论行
  - **全屏解耦**: 交互模式进入 alternate screen buffer(OSC 1049), TUI 独占整屏、不污染终端滚动历史; 退出时原样恢复调用方终端(参考 tmux/opencode 客户端模式)
  - **Plan / Build 双模式**(Tab 切换): Plan 模式提交任务 → 只生成计划(DAG 骨架实时流式展示在活动面板, 不执行), 计划记入会话历史; Build 模式提交 → 完整执行(自动拆解 → VBuild → RBuild 确认落盘)。先想清楚, 再动手
- **拆解过程可见**: 拆解阶段 LLM 流式输出实时显示在对话流(左 rail 块, 含已等待时长), 活动面板同步 —— 全程不是黑盒
- **输入行质感**: 底部固定圆角填充输入框(背景微色 + 边框), 焦点时边框亮起; 自研输入行对 IME 安全(ref 同步镜像, 中文输入法连发事件不再导致光标漂移/丢字)
  - **任务树数据层**(`src/ui/tree.tsx`): 从运行事件增量构建(幂等), 渲染与数据分离
  - **`/plan <任务>`**: 让 LLM 把任务拆解为 DAG 计划, 交给 Influx 运行时**全并行执行**(无依赖节点同波并行, 依赖链自动串行) —— 对话理解 + 计划执行的"1+1>2"
  - **thinking 过程可视化**: 拆解阶段 LLM 生成的计划 JSON 流式显示在活动面板(实时滚动), 完成后对话流输出计划骨架摘要 —— 不再是"黑盒等待后突然出结果"
  - **拆解约束**: 拆解 LLM 禁止用 llm 节点做任务主体, 强制 agent.read/glob/grep + write-file 等文件工具; 纯分析 spec 自动回退对话执行
  - **`/vbuild <任务>` 两段式构建(VBuild → RBuild)**: 所有 write/edit 先进内存 overlay(VBuild, 虚拟文件系统 `src/vfs.ts`), 全程零磁盘副作用; 完成后展示 diff(+ 新建 / ~ 修改 / − 删除), 输入 y 才 **RBuild 并行批量落盘**, 输入 n 丢弃(可回滚)。`/plan` 同样走两段式。**shell 可见性**: 执行 shell/bash 节点前自动把暂存的创建/修改 flush 到磁盘(`flushToDisk`), 因此 `write fix.sh → bash fix.sh` 能拿到构建中的文件; 丢弃构建时 flush 过的文件自动恢复原文
  - 状态栏: 右侧实时显示 `⠋ 拆解中 / 执行中 ×N` + 吞吐 `Nc/s`; 流式响应 60s 无数据自动报错(服务器挂起检测)
  - **诊断托盘**: `Ctrl+d` 展开/收起 —— 拆解失败原因、死循环警告、节点错误等默认折叠为细字, 信息永远可达但不占视觉
  - **内置设置面板**: TUI 内 `Ctrl+o`(或 `/config`)呼出,配置 LLM URL / API Key / Model,Enter 保存即生效并持久化到 `~/.minicode/config.json`(0600 权限,原子写);环境变量优先于配置文件
- **双引擎自动分流**: 每条消息先尝试由 LLM 拆解为 Influx DAG(1 次快速调用), ≥2 个可并行节点(文件/命令/远端 API) → 自动走 Influx 全并行执行(波次调度); 拆解失败/纯问答 → 回退对话循环。默认路径就吃上 Influx 并行能力, 无需手动 `/plan`
  - 拆解**重试机制**: 首次返回非合法 JSON 时, 把模型自己的输出回喂让其修正(一次机会); 解析容错(剥 markdown 代码块/前后文字/单引号/尾逗号); 限时 90s
- **AGENTS.md 项目规则**(对齐 opencode `/init`): 动态读取项目根 `AGENTS.md`(mtime 失效, ≤32KB)注入对话与拆解两处系统提示词; `/init` 命令让模型分析项目并生成/刷新 AGENTS.md(写入前需确认), 后续所有 session 自动注入
- **会话持久化**(对齐 opencode session): 对话自动落盘 `~/.minicode/sessions/`(防抖 800ms); `/sessions` 列出并按序号恢复; 启动 `--resume`/`-r` 自动恢复最近会话
- **/undo /redo**(对齐 opencode 撤销): 每次执行开启快照帧, 工具层写磁盘前记录原文(对话 write/edit、VBuild→RBuild 落盘均覆盖); `/undo` 逐帧回滚(新建→删除、修改→还原), `/redo` 重放
- **Axiom 基准原则嵌入 session**(`src/axiom.ts`): 仓库根 `axiom.md`(用户长期维护的从书式 AI 长期协作体系)是唯一真相源, **动态读取、绝不写死** —— 每次构建系统提示词按 mtime 重读, 文档更新后新 session 自动使用最新版。模式 `MINICODE_AXIOM=core|full|none`(默认 core): core 动态提取「第一部 · 从书式长期协作提示词」(文档自述可直接载入系统提示词的执行层, ~2.4K token), full 注入全文(>400KB 拒绝), none 关闭。对话引擎与拆解生成器共用同一基准; `MINICODE_AXIOM_PATH` 可指向其他项目副本
- **完整日志体系**(`src/log.ts`): 分级日志(debug/info/warn/error, `MINICODE_LOG_LEVEL` 控制)落盘 `~/.minicode/logs/minicode-YYYYMMDD.log`(按天分文件, 超 2MB 轮转); 结构化行 `[ISO时间] [级别] [作用域] 消息 {json}`; 埋点覆盖: 会话生命周期 / TUI 运行(拆解成败、引擎选择、构建结论) / agent 波次与工具成败 / influx 波次与节点错误 / RBuild 落盘; **崩溃兜底**(uncaughtException/unhandledRejection 带堆栈入日志); TUI 内 `/log` 命令回显最近 40 行
- **预测式预取**(计划 = 模型对自身后续行为的预测): 拆解阶段 LLM 还在流式生成计划 JSON 时, 就把其中声明的 `read-file` 路径**并行预读**进缓存(IO 隐藏在 LLM 延迟之后); 执行阶段运行时在每波开始前**预热下一就绪前沿的读输入**(DAG 已知下波要读什么)。`read-file` 命中缓存直接返回(标记 `prefetched`), `write-file` 真实写入后自动作废对应缓存防过期
- **拆解过程可视化**: LLM 生成计划 JSON 时流式显示在任务树占位节点(note 实时滚动), 完成后对话流输出 `📝 拆解分析:` 摘要 —— 不再是"黑盒等待后突然出结果"
- **计划执行全链路可见**: 被阻断节点也发 node-start/node-end 事件(依赖失败原因展示在任务树); 执行结束输出「✓ 构建完成: N 波, 总耗时 Xs」+ VFS diff(相对路径)
- **计划执行上下文不丢失**: runDual/`/plan` 执行后把「任务 + 每节点摘要 + 文件改动」合成一条助手消息记入会话历史, 下一条消息能接上
- **Esc 中断贯穿计划执行**: AbortSignal 传入 Runtime 与 shell/http/llm 工具, 并行执行中按 Esc 即时中止
- **终结条件**: stop(完成) / aborted(用户中断) / max_steps / doom_loop。死循环保护以**整批调用签名**为单位比较(只有整批与上一批完全一致才 +1): 波次内并行重复参数(如一步并行 read 同一文件两次)不会累积误杀, 真循环连续 3 波次先注入提示、警告后仍重复才中止

### Influx 计划运行时(`src/influx/`)

- **运行时**(`core.ts`): mini-react 架构语义移植 — render(计划→fiber 任务树) → reconcile(与上一轮快照 diff: placement/update/skip) → commit(就绪前沿并行执行工具,统一提交结果) → 重规划(计划函数随状态重渲染,直到稳定)
- **内置节点工具**(`tools.ts`): `http.get` / `http.post` / `shell` / `write-file` / `read-file` / `list-dir` / `llm`;计划文件可 `registerTool` 注册自定义工具
  - 路径工具统一相对 `ctx.cwd` 解析; `read-file` 超 50KB 截断(对齐对话侧); `shell` 输出上限 10MB; 均支持用户中断信号
  - **`llm` 节点支持 agent 模式**: 传 `tools` 数组(如 `["read", "bash"]`)则节点内跑完整 tool-call 回环(计划内嵌对话),返回 `{answer, steps, finish}`;流式输出按节点 key 分离(并行 llm 不串流),thinking 过程实时可见;不传则单问返回 `{answer}`。与对话侧共用同一 `LLMClient`
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
pnpm smoke:plan-fixes                       # 计划侧修复回归(history/中断/blocked 事件/引用/流式分离)
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
  ui/app.tsx         Ink TUI(双模式布局 + 结构化消息流 + 诊断托盘)
  ui/theme.ts        设计令牌(dark/light 淡紫蓝) + 自动主题检测
  ui/activity.tsx    活动面板(useActivity 事件桥 + 波次/节点渲染 + 焦点导航)
  ui/markdown.tsx    终端 Markdown 渲染(表格/列表/代码高亮/rail)
  ui/input.tsx       自定义输入行(Ctrl 组合键不插入文本, IME 安全光标)
  log.ts             日志体系(分级/落盘/轮转/崩溃兜底)
  axiom.ts           Axiom 基准原则(动态读取 axiom.md, 按 mtime 失效)
  agentsmd.ts        AGENTS.md 项目规则(动态读取 + /init 生成)
  session.ts         会话持久化(save/list/load/--resume)
  undo.ts            /undo /redo 文件级快照回滚
  ui/settings.tsx    设置面板(Ctrl+o 呼出)
  ui/tree.tsx        任务树数据层(事件增量构建, 幂等)
  ui/welcome.tsx     启动欢迎卡片(wordmark + 命令网格)
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

`pnpm typecheck && pnpm smoke && pnpm smoke:influx && pnpm smoke:plan-fixes` 必须全绿。smoke 覆盖: 工具回环、回喂、doom-loop、坏参 JSON、权限拒绝;influx smoke 覆盖: 干跑预览、缓存命中、when 分支、错误阻断、fallback、retry、自动 key、重复 key 快速失败、llm 节点 agent 模式(tool_calls 回环);plan-fixes 覆盖: historyMessage 多轮上下文、signal 中断、blocked 节点事件可见、`{$k.output}` 引用非空、read-file 截断与 cwd 解析、多 llm 节点流式分离、http 节点走 Influx、拆解过程流式(onStream 收到 delta)。

## 未实现(明确不做/后续)

- 上下文**摘要化**压缩(当前为体积截断,不做语义摘要)
- 会话持久化、多轮跨进程恢复
- 子 agent / MCP client / 插件
- 图片输入、多 provider 协议(non-OpenAI)
- 计划运行时与对话 agent 的深度统一(当前共用 CLI/环境变量/工具桥接,两套循环各自独立;计划内嵌对话已打通单点)

> 诚实说明: 真实 LLM 端到端未经当前环境验证(无 LLM_URL 配置)。smoke 用脚本化假 server 验证了协议与循环逻辑(含 llm 节点 agent 模式的 tool_calls 回环);接入真实模型需按上文配置环境后人工验证。
