# 交接与后续规划

> 时间: 2026-08-06(基线) · 2026-08-08(v0.5 定位收敛: 纯聊天 TUI, 无工具) · 2026-08-09(v0.6 双模式/项目内缓存/全局安装) · 2026-08-10(v0.7 体验版)
> 背景: 本仓库最初是对话式编码 agent(含 read/write/bash 等工具回环, 曾并入 Influx 计划运行时)。08-08 起移除 Influx 计划引擎与全部工具调用;08-09 按用户要求重新引入"命令行执行", 但以 **Tab 模式切换**形式(非模型工具回环)。
> 读者: 后续接手者 / 未来的自己。

## 1. 当前状态

MiniCode = 对话式 LLM TUI: 纯聊天(模型不调工具)+ **命令行模式**(Tab 切换, 输入直接 shell 执行, 非工具回环)。核心链路(SSE 客户端、会话、TUI)全部自研; 第三方依赖仅 ink/react。v0.7 起补上体验层(状态行/context 提醒//status/输入历史/通知/标题/归档/MRU)。

门禁全绿(实测 08-10, 可直接 `pnpm check`):
- `pnpm typecheck` → 0 错误
- `pnpm smoke` → 46/46(路径解析 / 配置 / v0.7 开关持久化 / LLM 流式聚合 / 500 重试 / 中断 / 会话 CRUD+归档 / 用量 / headless 结构化)
- `pnpm smoke:ui` → 28/28(视口滚动 / 命令表+MRU / 鼠标解析 / 状态行纯函数 / 输入历史 / 危险规则)
- `pnpm smoke:tui` → 20/20(真 PTY: A 消息→流式→落盘→双击退出;B Esc 不退出;C Tab 命令模式;D 危险闸门;E 状态行与 /statusline//status;F 慢速回答→BEL 通知)
- `pnpm build` → dist/minicode.mjs ≈1.9MB, banner 含 `v0.7.0` 版本标记

## 2. 关键设计决策(改前必读)

1. **零工具, 纯对话**: `llm.ts` 请求体不带 `tools` 字段, SSE 解析只聚合 `content` delta(忽略 `tool_calls`);系统提示词(`prompt.ts`)明确告知模型不调工具。新增功能不要引入工具注册/回环。
2. **Tab = 模式切换, 非补全**: 对话模式(LLM) ↔ 命令行模式(shell 执行)。命令行模式用 `execFile("/bin/sh -c", cmd, {cwd})`,30s 超时, 输出回显为结论块; **防嵌套**: 拒绝执行含 `minicode`/`tsx src/cli`/`pnpm dev` 等自身命令(否则命令行模式里再起 TUI = 递归)。见 `runShell`(`src/ui/app.tsx`)。**命令补全已死**——命令一律进命令面板。
3. **命令面板 = 唯一提示区**: `Ctrl+P` 或输入框首字符 `/` 打开(`src/ui/palette.tsx`), 展示 `src/commands.ts` 全部命令(分组 + 快捷键), 打字过滤, ↑↓ 选择 Enter 执行, Esc 关闭; 会话列表恢复也走面板(ctrl+x `l`)。**常规界面上不推送任何操作提示**(Tab 切换/Esc 取消/ctrl+x 二级键全部静默; 空态只有一行极简引导)。新增命令: 在 `commands.ts` 加一条(组/描述/快捷键), 面板与分发自动跟上。
4. **Esc 不退出**: Esc 只做取消(关闭面板/中断请求/退出命令模式); 退出唯一入口 = **Ctrl+C 双击**(ink exitOnCtrlC=false 已有; 空闲首按提示,3s 内再按退出)。
5. **数据目录 = `<cwd>/.minicode/`**: 配置/会话/日志全项目内, `MINICODE_HOME` 可覆盖。**路径必须动态读取**(`src/paths.ts` 的 homePath/ensureHome 等按需调用)—— 前代 bug 就是因为顶层缓存 `homedir()` 导致测试脏写真实配置。
6. **配置面板**(`Ctrl+o`, 首启自动打开): 直接改 `loadConfig()` + 覆写 `process.env`(applyConfigToEnv 只填未设置项, 不能用来刷新已启动的 env)。
7. **剪贴板**(`src/clipboard.ts`): pbcopy/clip/xclip-xsel 顺序尝试。快捷键 ctrl+x `c`(复制最后回答)/ `v`(复制我的问题)。
8. **构建/安装**: `pnpm build` → `scripts/build.mjs`(esbuild 单文件 bundle, stub 掉 ink 的可选 devtools 依赖)→ `dist/minicode.mjs`(带 shebang ≈1.8MB)。`install.sh` 交互安装(构建 → 复制到 ~/.local/bin 或 /usr/local/bin → 写 PATH; `-y` 自动; `uninstall` 卸载)。
9. **根 tsconfig `"jsx": "preserve"`**: app.tsx 必须 `import React from "react"`,@types/react 19 的 JSX 由 `src/ui/react-jsx.d.ts` 桥接。
10. **Ctrl+C 语义**: ink exitOnCtrlC:false, App tack 接管 —— 忙时首按取消请求、空闲首按提示,3s 内再按退出。
11. **SGR 鼠标序列在 ink 之前代理剥离**(`src/ui/mouse.tsx`),否则会被 ink 当文本打进输入框。
12. **Pty e2e 的坑**: 必须用异步 spawn(execFileSync 会阻塞事件循环 → 同进程 mock 服务器无法响应)。测试隔离用 `MINICODE_HOME` 指向临时目录(不能改 HOME, 模块动态读 MINICODE_HOME)。
13. **会话持久化**: msgs 防抖 800ms 落盘;`historyRef` 与 UI msgs 分开维护;退出前 flush。
14. **面板行为细节**: 打开时记住草稿、关闭(含 Esc)恢复; 面板打开时 `busy` 只放行 help/sessions 类只读命令; 面板高度计入视口预留(chromeRows), 不会把输入框挤出屏幕。
15. **会话治理**: `session.ts` 的 `title` 字段承载重命名(`renameSession`),列表展示 `title ?? firstMsg`; `forkSession` 复制为新 id(新时间戳); `deleteSession` 已存在。TUI 面板 sessions 阶段 `d`=二次确认删除(防误删, 当前会话禁止)、`r`=进入重命名(输入框预填, Enter 提交 Esc 放弃); 面板内 session 操作在 `busy` 时被拒绝。headless `--resume=<id>`(不带 id 恢复最近)续问并落回原会话。
16. **危险命令闸门**: `src/danger.ts` 静态规则(少误报为纲, 10 条: rm 根目录/家/当前、.git/.minicode、管道远端脚本、git push --force、磁盘级、关机重启、fork 炸弹、chmod 777 根目录、写设备); 命中不执行, `confirmReq` 状态弹单键确认(Ui: [y] 一次/[a] 本会话/[Esc] 取消), 期间 useInput 全部键归确认; `shellAllowAllRef` 会话级放行, `/new` 清零。
17. **用量账本**: `src/usage.ts` 单文件无依赖; 结构 `{sessions, daily}` 落盘 `<home>/usage.json`(0600, 防抖 300ms, `flushUsage` 进程退出兜底); TUI 在 runChat(含 compact)与 headless runTurn 都 recordUsage; verdict 附用量行仅在 totalTokens>0 时显示。
18. **多 provider**: `config.ts` 的三层语义 —— `providers` 命名快照 > 顶层 legacy 字段(="default" 快照); 当前名 = `LLM_PROVIDER` env > `config.provider` > "default"; `loadConfig` 返回当前快照生效值, `saveConfig` 只合并顶层(保留 providers 结构), 设置面板改走 `saveProviderProfile`。env 优先级: 用户自设 env 恒优 —— 本模块/面板写入的 env 记入 `forced` 集合, `/provider` 切换时 `resetForcedEnv()` 撤销再按新快照填充; `/provider X` 创建+切换+立即生效(进程内不重启), 头部/t设置面板显示当前 provider。
19. **headless 结构化输出**: `runTurn(fmt)` —— text(默认)/json(结束后单对象)/stream-json(每事件一行 NDJSON: delta/usage/done); `--json` 隐式 `--headless`(带 --resume 也能结构化, 回答照旧落回会话); 退出码 0 成功 / 1 失败 / 2 配置缺失, main().catch 里按错误文案映射并输出 `{ok:false,error,exitCode}` JSON。**调试教训**: 测试里 spawnSync 起子进程 + 同进程内 mock server = 死锁(阻塞父事件循环 → server 无法响应子进程), 必须用异步 spawn。
20. **v0.7 体验层**(方案对标 Claude Code statusline / Codex /status):
    - **状态行**: `src/ui/statusline.tsx` 底部一行 `model · ↑in ↓out · 今日 · 时长`, 默认开; 配置键 `statusline`(false=关); 开着才挂 1s 节拍定时器(`tlTick` 触发重渲染); **chromeRows 必须 +1** 否则消息区把状态行挤出屏幕。
    - **context 提醒**: 每轮结束取 `result.usage.inputTokens`(>0 才可信)写入 `ctxTokensRef`, 与 `contextLimit`(配置, 默认 32000)对比; `ctxWarnRef` 记录已告警水位(70/90, 各一次), `/compact`/`/new` 都归零 —— 两个 refs 都是"近一轮状态", 不是累积历史。
    - **/status**: 纯 UI 汇总(provider/model/url · 会话时长消息数 · 上下文占用% · 用量三行 · 开关状态); `/models` `/usage` 原语义保留, **不要给 status 加 aliases**(会抢 matchCommands 分发)。
    - **输入历史**: 纯函数 `input-history.ts`(`walkHistory`/`rememberInput`)可单测; App 侧 `inputHistIdxRef=-1` 表示未浏览, 首次向上存草稿, 向下越界还原草稿。Ctrl+↑/↓ 只在主上下文生效(面板/设置分支已提前 return)。
    - **完成通知**: ≥8s 且非 aborted/error 时 `stdout.write("\x07" + OSC9序列)`; OSC9 结尾自带 BEL, 前面再单独一个 BEL 做终端响铃。e2e F 用 9s 慢速 mock, 断言剥离 OSC 后仍残留的独立 BEL。
    - **标题联动**: OSC 0 序列同样 `stdout.write`(stripper 会剥掉, e2e 断言不了); 流式开始设 `minicode · model · cwd`, runChat 结束与任何退出路径(`/quit`/exitConfirmed)置空。
    - **归档**: `SessionRecord.archived?` + `setArchived(id,v)`; `listSessions` 返回全部并带 archived 标记, UI 侧 `paletteScopedRef` 过滤; **`latestSession` 必须跳过归档**(否则 --resume 会恢复归档会话); 归档可逆, 面板 `a` 单键实现, 归档模式下 Enter=取消归档+恢复。
    - **命令 MRU**: `rankCommands(query, mru)` 排序只发生在面板渲染/分发路径; mru 是**会话级内存**(ref, 不落盘), 关闭即失。
    - **/update**: 本地信息(版本 + 升级方式), 不联网(GitHub 端点未定, 不写死假 URL)。
    - **429 文案**: runChat catch 里 `msg.includes("429")` 分支, 附带今日用量 + 建议动作。
    - 配置新增键 `statusline/contextLimit/notify` 都在 loadConfig/saveConfig 顶层合并回路(与 theme/dense 同模式)。

## 3. 文件索引

```
src/cli.ts               统一入口(TUI / --headless / --cwd / -r / --provider / --json / --stream-json; 设置 MINICODE_HOME 并确保目录)
src/llm.ts               SSE 流式客户端(零网络库, 自解析, idle 超时/退避重试/中断)
src/prompt.ts            系统提示词(纯对话)
src/paths.ts             数据目录解析(MINICODE_HOME → <cwd>/.minicode)
src/session.ts           会话持久化(save/list/load/delete/resume)
src/config.ts            用户配置(.minicode/config.json, 原子写/0600/防御加载)
src/clipboard.ts         剪贴板适配(pbcopy/clip.exe/xclip-xsel)
src/log.ts               日志体系(分级/落盘/轮转/崩溃兜底)
src/notify.ts            终端通知
src/console-patch.ts     TUI 期间 console.* 重定向
src/commands.ts          命令注册表(单一来源: / 命令 + ctrl+x 领衔键 + 命令面板; 含 rankCommands MRU)
src/danger.ts            危险命令静态闸门(命令行模式执行前)
src/usage.ts             用量账本(会话/按天 token, /usage; fmtTokens 供状态行复用)
src/input-history.ts     输入历史纯函数(walkHistory / rememberInput)
src/version.ts           版本常量(v0.7.0, 与 package.json / dist banner 同源)
src/types.ts             共享类型
src/ui/app.tsx           TUI 主组件(消息流/输入/Ctrl+C/Esc 语义/Tab 模式/命令分发/runShell/状态行/context 提醒/通知/标题/归档)
src/ui/statusline.tsx    底部状态行(StatusLine + formatDuration)
src/ui/theme.ts          主题 tokens(dark/light)
src/ui/markdown.tsx      Markdown 渲染
src/ui/viewport.tsx      视口滚动
src/ui/input.tsx         输入行
src/ui/mouse.tsx         鼠标代理
src/ui/settings.tsx      配置面板
src/ui/palette.tsx       命令面板(commands/sessions 两阶段, 会话页支持归档作用域)
scripts/build.mjs        esbuild 单文件打包(dist/minicode.mjs, banner 注入版本)
install.sh               交互安装脚本(全局注册)
test/smoke.ts            配置/路径/LLM/会话/归档/用量/headless 结构化冒烟(46)
test/ui-utils.ts         UI 纯函数 + 输入历史 + MRU + 危险规则(28)
test/tui-e2e.ts          PTY e2e(20, 含慢速通知场景 F)
```

## 4. 已知限制 / 技术债

- **真实 LLM 端到端未验证**: 环境无真实端点, 只有假 server 冒烟; 接真实模型用 `Ctrl+o` 设置面板或环境变量后人工验证.
- TUI e2e 依赖 `python3` 驱动 PTY(本机自带),CI 缺 python3 需适配; 场景 F 含 9s 慢速 mock, 全套约 60s。
- `dist/` 只在 build 后产生; `bin` 指向 dist 需先 `pnpm build`(install.sh 内部已处理)。
- 命令行模式: 有交互/长驻命令(如 vim/top)不适用(30s 超时 kill); 不支持交互 stdin。
- 命令 MRU 为会话级内存(不落盘, 重启即失); /update 是本地提示(未接远端版本源)。
- 状态行开着时有一个 1s 节拍定时器持续触发渲染(ink diff 小, 可接受; 介意可 /statusline 关)。

## 5. 后续规划

### 已完成
- [x] v0.5(08-08): 移除全部 agent 引擎与工具调用, 纯聊天 TUI
- [x] v0.6(08-09): Tab 命令行模式; Esc 不退出; 项目内 .minicode 缓存; Ctrl+x 复制/会话快捷键; 独立配置面板; install.sh 全局安装
- [x] v0.6.1(08-09): 命令面板(Ctrl+P / "/" 呼出, 全部命令单一来源 `src/commands.ts`, 会话恢复入面板); 界面静默化(无操作提示推送); 移除 welcome.tsx
- [x] v0.6.2(08-09): 会话治理 —— 面板 sessions 阶段 `d` 删除(二次确认, 当前会话禁止)/`r` 重命名(title 字段); `/fork` 复制当前会话为分支; headless `--resume[=<id>]` 续问并落回原会话
- [x] v0.6.3(08-09): 用量统计(usage.json 会话/按天, /usage, verdict 附带用量) + 危险命令闸门(静态规则 + 单键确认 [y]/[a]/[Esc])
- [x] v0.6.4(08-10): 多 provider 快照(`/provider` 切换/创建, --provider, env 优先级与强制撤销) + headless 结构化输出(--json/--stream-json, 退出码 0/1/2); 查漏补缺 —— 领衔键 u/f/o、busy 只读清单、compact 用量行、danger sudo/zsh/eval 补强、退出 flushUsage
- [x] **v0.7 体验版**(08-10): 状态行(/statusline)/ context 占用提醒(contextLimit 70%/90%)/ /status 总览 / 输入历史 Ctrl+↑↓ / 长回答完成通知(/notify, BEL+OSC9) / 终端标题联动 / 会话归档(/archive + /archived + 面板 a 键) / 命令 MRU / 429 文案 / /update; package.json 0.7.0, dist banner 版本标记, `pnpm check` 一键门禁

### P0 — 稳定
- [ ] 真实 LLM 端到端人工验证
- [ ] `/update` 接真实远端版本源(GitHub Releases, 端点未定不写死)

### P1 — 打磨
- [ ] 会话"恢复最近"交互选择器(当前走面板 ctrl+x `l` + /sessions)
- [ ] 主题自动切换平滑化
- [ ] 命令 MRU 落盘(跨进程习惯保持, 当前会话级内存)

### P3 — 工程化
- [ ] `pnpm link` 全局体验补测试 / CI 组合跑 `pnpm check`

## 6. 快速上手

```bash
cd ~/Code/MiniCode
pnpm install
pnpm check                       # 门禁(typecheck + smoke46 + smoke:ui28 + smoke:tui20 + build)
LLM_URL=<endpoint> LLM_API_KEY=<key> LLM_MODEL=<model> pnpm dev     # 本机 TUI
bash install.sh -y                                                # 全局安装
minicode                                                          # 任意目录可用(自动项目内 .minicode/)
```