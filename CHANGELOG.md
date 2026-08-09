# Changelog

本文件记录 MiniCode 的版本迭代(Keep a Changelog 风格)。

## [Unreleased]

### 2026-08-09 v0.6 易用性与全局安装
- **Tab 不再用于补全, 改为切换 对话模式 ↔ 命令行模式**: 命令行模式输入直接作为 shell 命令执行(cwd, 30s 超时, 输出回显为结论块); 自动阻止命令内嵌套启动 minicode 自身(防循环)
- **退出只能 Ctrl+C 双击; Esc 只取消不退出**(关闭面板/中断/退出命令模式), 消除误触退出
- **项目内缓存**: 数据目录改为 `<cwd>/.minicode/`(配置/会话/日志全在项目内, `MINICODE_HOME` 可覆盖); 启动自动创建, 多项目隔离
- **新快捷键**: Ctrl+x `c` 复制最后回答(剪贴板, pbcopy/clip/xclip 自动适配), `v` 复制我的问题; `l` 会话列表
- **独立配置面板**: `Ctrl+o` 打开; 首启未配置自动弹出引导; 改动保存即生效(直接覆写进程 env)
- **安装脚本**(`install.sh`): 交互式构建 + 全局注册(bin) + PATH 自动写入, 支持 `-y` 自动与 uninstall; esbuild 单文件打包(`dist/minicode.mjs`, scripts/build.mjs)
- 会话/配置路径全部动态解析(`src/paths.ts`), 测试隔离切换为 MINICODE_HOME
- 门禁: `pnpm typecheck && pnpm smoke(20) && pnpm smoke:ui(14) && pnpm smoke:tui(10· 含 Esc/S 行为)` 全绿

### 2026-08-08 v0.5 定位收敛(纯聊天 TUI)
- **移除全部工具调用与回环**: 删 `src/tools.ts` / `loop.ts` / `vfs.ts` / `undo.ts` / `policy.ts` / `webfetch.ts` / `refs.ts` / `exec-stream.ts` / `agentsmd.ts`;LLM 只流式输出文本
- **移除外来引擎残留**: Influx 计划运行时整体(src/influx/)、MCP、plan CLI、examples、axiom、tsconfig.plans.json(上一轮已删, 本轮彻底清引用)
- TUI 重构为纯聊天: `runChat` 直接 `client.stream`(无回环);命令表与欢迎卡片去掉 /init /undo /redo;headless 简化
- 测试重写: `smoke` 17 项(配置/LLM 流式/重试/中断/会话)、`ui-utils` 14 项(去 refs/policy)、删 `web-tools` 与依赖 undici
- 门禁: `pnpm typecheck && pnpm smoke && pnpm smoke:ui && pnpm smoke:tui` 全绿

### Added
- **移除 Influx 计划运行时整体**(`src/influx/`)、MCP 服务器、`plan run/bench/view` CLI、`examples/*.plan.tsx`、axiom 体系、`tsconfig.plans.json` 与计划侧 smoke 测试
- 重写 `src/ui/app.tsx` 为简洁聊天界面(去双模式/任务树/拆解竞速),菜单与命令注册表精简
- 命令注册表移除 plan/vbuild/parallel/details;欢迎卡片更新
- tui-e2e 改为异步 spawn(mock 与 PTY 解耦),4 断言全绿;回答完成落 verdict
- 验证门禁: `pnpm typecheck && pnpm smoke(27) && pnpm smoke:ui(21) && pnpm smoke:web(23) && pnpm smoke:tui(4)` 全绿
- 依赖收敛: 仅 ink/react(移除 undici/zod/@modelcontextprotocol/ink-text-input)

### Added
- Axiom 基准原则嵌入 session: 动态读取 `axiom.md`(mtime 失效, 不写死), `MINICODE_AXIOM=core|full|none` 控制, 拆解与对话共用
- AGENTS.md 项目规则: 动态注入 + `/init` 生成(`src/agentsmd.ts`)
- 会话持久化: `~/.minicode/sessions/`, `/sessions` 恢复, `--resume` 启动续接(`src/session.ts`)
- `/undo` `/redo`: 文件级快照回滚(`src/undo.ts`), 覆盖对话 write/edit 与 RBuild 落盘
- 完整日志体系: 分级落盘 `~/.minicode/logs/`(按天/轮转), 崩溃兜底, `/log` 回显(`src/log.ts`)
- 预测式预取: 拆解流式 JSON 预读 + 运行时预热下一前沿, write-file 自动失效缓存
- Plan/Build 双模式(Tab 切换): Plan 只生成计划不执行
- 全屏 TUI: alternate screen buffer 解耦, 退出原样恢复

### Added
- 并行执行过程可视化: 左侧过程 feed(llm 节点流式输出实时可见) + 波次/节点实时进度条 + `执行中 · 波次 X/Y`
- 拆解三重保险: 首次失败带具体解析错误回喂(只回喂输出尾部) → 二次失败用极简提示+温度 0 抢救; 失败原因内联显示 + 原始输出入日志
- 拆解成功消息显示耗时; 打字机提速(12ms/tick, 8/4/2 步进, 长输出不再拖沓)

### Changed
- 声明 → 执行 两阶段模型: 生成 spec 时每个节点带 desc 意图注释(函数级注释), 执行严格按声明跑, 不跑偏
- VBuild 与对话提交统一走同一构建路径(声明 → 执行 → 落盘确认)
- 执行过程 feed 显示**所有波次**(完成波次内容持续可见, 流式内容实时渲染), 不再只显示最后一个活动波次
- 去除 UI 宣传性措辞(如"全并行执行"), 只保留事实性描述

### Added
- @ 文件实时补全: 输入 @query 即出候选(git ls-files + glob 合并索引), Tab 补全
- /editor: 外部编辑器撰写消息($EDITOR, GUI 编辑器优先, 保存后自动读入输入框)
- /details: 展开/收起全部节点详情; /connect: 配置提供方(/config 别名)
- 视口高度实时计入命令候选/领衔提示行数, 输入框不再被顶出屏幕; 头部压缩一行

### Changed
- **subagent × 递归取长补短**: 拆解提示改为双策略 —— 路径明确的任务拆成原子节点并行(性能主力), 需要判断/多步推理/跨文件探索的任务用 llm+tools 子代理(自己决定怎么做); 递归拆解不再切 agent 节点(它自带判断力)
- **子代理上下文继承(信息流通)**: 节点 desc 声明注入子代理系统提示, 知道自己在计划里的角色边界; 内部工具调用/结果逐条流式可见(→ write a.ts / ✓ write), 不再黑盒; 结果带 writes 统计, 下游可判断是真干活还是只读聊天
- **权限策略(减少无谓交互, 对齐 opencode)**: 项目内读写、日常命令(test/build/git status)静默放行; 只有项目外路径(其他目录)、系统/破坏性命令(rm -rf / sudo / git push --force / curl|sh)才确认; 确认改为单键交互 [y] 本次 [a] 会话全放行 [Esc] 拒绝
- **鼠标修复**: SGR 序列不再经 ink 解析器(它会把 \x1b[<0;12;34M 当文本打进输入框), 改为代理 stdin 在 ink 之前剥离鼠标序列并转发其余字节; X10 兜底解析

### Changed
- **调度器重写: 波次屏障 → 事件驱动就绪队列**(core.ts): 任一节点完成立即重算依赖并启动下游, 不再等"同波兄弟"全部完成 —— 小任务的下游不再被大任务拖死; 全局并发上限默认 min(8, CPU核), /parallel N 可调; "波次"退化为展示分组
- **递归深度拆解**(plan-runner.ts): 大节点(长命令/大写入/agent 模式/宽泛 desc)自动再拆一层(深度≤2, 节点≤40, 多个子拆解并行发起); 子 key 带父前缀、内部引用重写、父节点变 Flow+聚合输出, 下游 {$parent.output} 无感于被拆过; 子拆解失败保留叶子不丢信息
- **shell/bash 流式执行**(exec-stream.ts): exec → spawn 逐 chunk 实时推流, 长命令不再"7 分钟零信息"; llm/bash/agent.* 节点统一实时可见
- **执行过程默认展开**: 右侧面板运行中节点始终显示流式内容, 不再靠按键展开
- **SGR 鼠标支持**(mouse.tsx, 零依赖): 点击节点行展开/收起, 滚轮面板内滚动, 去掉不必要的按键操作
- 拆解阶段逐 key 推流(每声明一个节点显示一行), 非流式端点给出等待提示与说明

### Fixed
- 拆解失败回退对话后模型"只读不写": ① 回退系统提示注入[执行模式]——user 消息即任务, 不许反问/复述原则, 直接动手; ② 连续 6 轮无写调用注入只读停滞催促; ③ writes=0 且多轮时如实报告"未修改任何文件", 不再假装完成
- [llm] 流式读取中断重试上限 2→3 次(网络抖动更抗造)

### Added
- **拆解+对话真并行(opencode 模式)**: Build 提交后对话立即开始流式回答, 拆解(DAG 声明)转入后台与它赛跑; 拆解 15s 内合格(≥2 节点 + 文件操作)且对话尚未动手(0 工具调用 & 输出 <300 字符) → 中止对话草稿、切换为声明式执行(界面提示"⚡ 拆解先行完成, 切换为声明执行"); 否则对话自然完成, 后台拆解停止(不再"先规划后响应", 首响应从拆解延迟中解放)
- **Ctrl+C 语义对齐(opencode/Claude Code)**: 忙时首次取消当前任务, 空闲首次提示"再按一次 Ctrl+C 退出"; 3s 内再按才退出, 其他按键解除 — 杜绝习惯性 Ctrl+C 误杀会话(ink exitOnCtrlC=false)
- **console 输出重定向**: TUI 期间所有杂散 console.* 写入 ~/.minicode/logs/console-{pid}.log, 第三方依赖/子进程输出不再污染 alternate screen
- **webfetch 工具**(对话侧 + 计划侧 web.fetch): URL → markdown/text/html, 5MB 上限、30s 超时(可调 120s)、仅 http/https、403 自动换浏览器 UA 重试 — 零依赖 HTML→MD 转换器
- **websearch 工具**(对话侧 + 计划侧 web.search): Exa REST 契约, 设置 MINICODE_EXA_KEY 才注册(可 MINICODE_EXA_URL 覆盖端点, 便于代理/测试)
- **TUI 端到端回归测试**(test/tui-e2e.ts, pnpm smoke:tui): 真 PTY 驱动完整 TUI, 断言会话文件真值 — 竞速切换/对话胜出/Ctrl+C 语义/干净退出

### Fixed
- **"自动清屏/自动停止"根因修复(第二层)**: 任何渲染错误都会让 ink 的 ErrorBoundary 直接卸载整个 TUI(表现为屏幕恢复成终端、看起来"自动停止"); 现在 App 最外层包了自己的错误边界, 渲染错误就地显示并写入日志, 不再退出
- **首个响应延迟**: 拆解(声明)阶段超时 90s→15s, 超时立即回退对话执行(模型直接开始流式回答); 拆解界面明确显示"15s 内未完成将直接对话执行"; LLM 流式 idle 超时 60s→45s(挂起更快暴露)

### Fixed
- **修复"执行中清屏/像自动停止"**: 贴底活动区(流式输出/执行过程 feed)内容超过视口高度时, ink 的总输出高度会超过终端行数, 触发 shouldClearTerminalForFrame 每帧 clearTerminal —— 视口 Box 加 overflow=hidden 裁剪, liveH 上限 viewportRows-1, 双保险不再撑破
- **会话历史完整落盘**: 之前 800ms 防抖可能因退出/崩溃丢失最后几轮; 现在 /new、/quit、Esc、组件卸载(任意退出路径)都先立即落盘, 每轮对话都有 ~/.minicode/sessions/ 记录可查(msgs + LLM history)

### Fixed
- shell 节点空 cmd: 空字符串同样触发别名兜底; 模板引用({$k.output})解析为空时, 错误直接指向原始模板与可疑 key, 不再只报"缺少 cmd"
- 工具上下文注入解析前原始参数(rawParams), 供错误信息回看模型原始意图
- shell 节点 "缺少 cmd": 模型参数名漂移(command/script/cmdline → cmd)由 normalizeSpec 容错归一, 不再无谓失败
- 工具参数校验错误带节点上下文(节点 key + 收到参数), 一眼定位模型生成的缺陷
- 拆解提示词强化: shell 参数名必须为 cmd

### Fixed
- UI 顶部挤压: 欢迎卡片移入滚动视口(不再把输入框顶出屏幕), 顶部留白恢复 2 行, 头部下划线留白恢复
- 候选/领衔提示行数精确计入视口高度(含 margin), 输入框与提示不再被推出可视区

### Fixed
- /vbuild 提交后输入框未清空(重构引入)
- @ 补全在 gitignore 目录下无候选(git ls-files 空时 glob 兜底失效)

### Added
- 视口滚动: 把终端当网页 —— 主内容虚拟化滚动(↑↓/PgUp/PgDn/Home/End), 贴底自动跟随, 上滚解锁后显示"↑ 已滚动 N 行"
- 右侧活动面板与主内容彻底解耦: 固定高度 + 独立滚动(焦点时窗口跟随选中节点), 不再随对话溢出
- 帧级合并渲染: 流式 delta 合并到 16ms 帧一次重绘(流式=协程, 渲染=帧, 并行多流不丢帧)
- opencode 式命令: /export(转录 md) /compact(上下文压缩) /new /help /models /themes + ctrl+x 领衔快捷键(u撤销 r重做 n新会话 l会话 t主题 m模型 e导出 c压缩 d诊断 q退出)
- / 命令键入即候选 + Tab 补全; ctrl+p 命令面板; ctrl+u 清行
- attention 完成提醒: MINICODE_ATTENTION=1 开启终端响铃 + macOS 桌面通知(权限询问/构建结束)
- @file 引用: 模糊匹配文件自动注入上下文; !cmd 直接执行 shell 输出进对话(不走 LLM)
- 终端 resize 动态重算视口高度

### Fixed
- **视口滚动修复(消息消失/无法回滚)**: `computeWindow` 重写 —— 视口顶/底落在块内部时不再跳过整块(旧实现: 长流式回复 + 贴底偏移落在块中部 → 窗口为空 → 屏幕一片空白), 头尾被切的块用文本行级裁剪(`clipTextRows`/`clipTextRowsKeep`)显示真实内容; 活动区(流式/拆解/执行)并入同一个滚动文档, 不再从视口扣高度, 历史永远能上滚找回; 鼠标滚轮覆盖整个左区内容(原来只在面板上可用)
- llm 节点输出持久进对话流(不流式模型内容一次性到达不再"看完就消失"), 失败详情含 exit code + stderr
- 死循环保护误报: 改整批签名比较, 并行波次内重复参数不再累积误杀
- VBuild shell 可见性: `flushToDisk` 让 `bash fix.sh` 能读取暂存的 write-file 产物, 丢弃时自动恢复
- 中文输入法光标漂移: 输入行改用 ref 同步镜像
- Ctrl+d/Ctrl+o 不再向输入框插入字符

## [0.4.0] - 2026-08-06

### Added
- 双引擎自动分流: 消息先尝试拆解为 Influx DAG, ≥2 可并行节点自动全并行
- 拆解重试机制 + 容错解析 + 90s 超时
- TUI 重构: 设计令牌(dark/light)/ Markdown 表格/活动面板/诊断托盘
- VBuild/RBuild 两段式构建, VFS 虚拟文件系统
- 上下文压缩(128KB), 流式打字机渲染

### Fixed
- 拆解失败回退对话后的死循环误判
- write-file 空内容引用
