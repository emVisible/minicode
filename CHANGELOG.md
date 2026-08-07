# Changelog

本文件记录 MiniCode 的版本迭代(Keep a Changelog 风格)。

## [Unreleased]

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
- **调度器重写: 波次屏障 → 事件驱动就绪队列**(core.ts): 任一节点完成立即重算依赖并启动下游, 不再等"同波兄弟"全部完成 —— 小任务的下游不再被大任务拖死; 全局并发上限默认 min(8, CPU核), /parallel N 可调; "波次"退化为展示分组
- **递归深度拆解**(plan-runner.ts): 大节点(长命令/大写入/agent 模式/宽泛 desc)自动再拆一层(深度≤2, 节点≤40, 多个子拆解并行发起); 子 key 带父前缀、内部引用重写、父节点变 Flow+聚合输出, 下游 {$parent.output} 无感于被拆过; 子拆解失败保留叶子不丢信息
- **shell/bash 流式执行**(exec-stream.ts): exec → spawn 逐 chunk 实时推流, 长命令不再"7 分钟零信息"; llm/bash/agent.* 节点统一实时可见
- **执行过程默认展开**: 右侧面板运行中节点始终显示流式内容, 不再靠按键展开
- **SGR 鼠标支持**(mouse.tsx, 零依赖): 点击节点行展开/收起, 滚轮面板内滚动, 去掉不必要的按键操作
- 拆解阶段逐 key 推流(每声明一个节点显示一行), 非流式端点给出等待提示与说明

### Fixed
- 拆解失败回退对话后模型"只读不写": ① 回退系统提示注入[执行模式]——user 消息即任务, 不许反问/复述原则, 直接动手; ② 连续 6 轮无写调用注入只读停滞催促; ③ writes=0 且多轮时如实报告"未修改任何文件", 不再假装完成
- [llm] 流式读取中断重试上限 2→3 次(网络抖动更抗造)

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
