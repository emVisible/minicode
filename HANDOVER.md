# 交接与后续规划

> 时间: 2026-08-06(基线) · 2026-08-08(v0.5 定位收敛: 纯聊天 TUI, 无工具) · 2026-08-09(v0.6 双模式/项目内缓存/全局安装)
> 背景: 本仓库最初是对话式编码 agent(含 read/write/bash 等工具回环, 曾并入 Influx 计划运行时)。08-08 起移除 Influx 计划引擎与全部工具调用;08-09 按用户要求重新引入"命令行执行", 但以 **Tab 模式切换**形式(非模型工具回环)。
> 读者: 后续接手者 / 未来的自己。

## 1. 当前状态

MiniCode = 对话式 LLM TUI: 纯聊天(模型不调工具)+ **命令行模式**(Tab 切换, 输入直接 shell 执行, 非工具回环)。核心链路(SSE 客户端、会话、TUI)全部自研; 第三方依赖仅 ink/react。

门禁全绿(实测 08-09):
- `pnpm typecheck` → 0 错误
- `pnpm smoke` → 20/20(路径解析 / 配置 / LLM 流式聚合 / 500 重试 / 中断 / 会话 CRUD)
- `pnpm smoke:ui` → 14/14(视口滚动 / 命令表 / 鼠标解析)
- `pnpm smoke:tui` → 10/10(真 PTY: 消息 → 流式回答 → 落盘 → 双击退出;Esc 不退出;Tab 命令模式执行)

## 2. 关键设计决策(改前必读)

1. **零工具, 纯对话**: `llm.ts` 请求体不带 `tools` 字段, SSE 解析只聚合 `content` delta(忽略 `tool_calls`);系统提示词(`prompt.ts`)明确告知模型不调工具。新增功能不要引入工具注册/回环。
2. **Tab = 模式切换, 非补全**: 对话模式(LLM) ↔ 命令行模式(shell 执行)。命令行模式用 `execFile("/bin/sh -c", cmd, {cwd})`,30s 超时, 输出回显为结论块; **防嵌套**: 拒绝执行含 `minicode`/`tsx src/cli`/`pnpm dev` 等自身命令(否则命令行模式里再起 TUI = 递归)。见 `runShell`(`src/ui/app.tsx`)。
3. **Esc 不退出**: Esc 只做取消(关闭面板/中断请求/退出命令模式); 退出唯一入口 = **Ctrl+C 双击**(ink exitOnCtrlC=false 已有; 空闲首按提示,3s 内再按退出)。
4. **数据目录 = `<cwd>/.minicode/`**: 配置/会话/日志全项目内, `MINICODE_HOME` 可覆盖。**路径必须动态读取**(`src/paths.ts` 的 homePath/ensureHome 等按需调用)—— 前代 bug 就是因为顶层缓存 `homedir()` 导致测试脏写真实配置。
5. **配置面板**(`Ctrl+o`, 首启自动打开): 直接改 `loadConfig()` + 覆写 `process.env`(applyConfigToEnv 只填未设置项, 不能用来刷新已启动的 env)。
6. **剪贴板**(`src/clipboard.ts`): pbcopy/clip/xclip-xsel 顺序尝试。快捷键 ctrl+x `c`(复制最后回答)/ `v`(复制我的问题)。
7. **构建/安装**: `pnpm build` → `scripts/build.mjs`(esbuild 单文件 bundle, stub 掉 ink 的可选 devtools 依赖)→ `dist/minicode.mjs`(带 shebang ≈1.8MB)。`install.sh` 交互安装(构建 → 复制到 ~/.local/bin 或 /usr/local/bin → 写 PATH; `-y` 自动; `uninstall` 卸载)。
8. **根 tsconfig `"jsx": "preserve"`**: app.tsx 必须 `import React from "react"`,@types/react 19 的 JSX 由 `src/ui/react-jsx.d.ts` 桥接。
9. **Ctrl+C 语义**: ink exitOnCtrlC:false, App tack 接管 —— 忙时首按取消请求、空闲首按提示,3s 内再按退出。
10. **SGR 鼠标序列在 ink 之前代理剥离**(`src/ui/mouse.tsx`),否则会被 ink 当文本打进输入框。
11. **Pty e2e 的坑**: 必须用异步 spawn(execFileSync 会阻塞事件循环 → 同进程 mock 服务器无法响应)。测试隔离用 `MINICODE_HOME` 指向临时目录(不能改 HOME, 模块动态读 MINICODE_HOME)。
12. **会话持久化**: msgs 防抖 800ms 落盘;`historyRef` 与 UI msgs 分开维护;退出前 flush。

## 3. 文件索引

```
src/cli.ts               统一入口(TUI / --headless / --cwd / -r; 设置 MINICODE_HOME 并确保目录)
src/llm.ts               SSE 流式客户端(零网络库, 自解析, idle 超时/退避重试/中断)
src/prompt.ts            系统提示词(纯对话)
src/paths.ts             数据目录解析(MINICODE_HOME → <cwd>/.minicode)
src/session.ts           会话持久化(save/list/load/delete/resume)
src/config.ts            用户配置(.minicode/config.json, 原子写/0600/防御加载)
src/clipboard.ts         剪贴板适配(pbcopy/clip.exe/xclip-xsel)
src/log.ts               日志体系(分级/落盘/轮转/崩溃兜底)
src/notify.ts            终端通知
src/console-patch.ts     TUI 期间 console.* 重定向
src/commands.ts          命令注册表 + ctrl+x 领衔键(新: c=复制回答 v=复制问题)
src/types.ts             共享类型
src/ui/app.tsx           TUI 主组件(消息流/输入/Ctrl+C/Esc 语义/Tab 模式/命令分发/runShell)
src/ui/theme.ts          客户端引导
src/ui/markdown.tsx      Markdown 渲染
src/ui/viewport.tsx      视口滚动
src/ui/input.tsx         输入行
src/ui/mouse.tsx         鼠标代理
src/ui/settings.tsx      配置面板
src/ui/welcome.tsx       欢迎卡片
scripts/build.mjs        esbuild 单文件打包(dist/minicode.mjs)
install.sh               交互安装脚本(全局注册)
test/smoke.ts            配置/路径/LLM/会话冒烟(20)
test/ui-utils.ts         UI 纯函数(14)
test/tui-e2e.ts          PTY e2e(10)
```

## 4. 已知限制 / 技术债

- **真实 LLM 端到端未验证**: 环境无真实端点, 只有假 server 冒烟; 接真实模型用 `Ctrl+o` 设置面板或环境变量后人工验证.
- TUI e2e 依赖 `python3` 驱动 PTY(本机自带),CI 缺 python3 需适配。
- `dist/` 只在 build 后产生; `bin` 指向 dist 需先 `pnpm build`(install.sh 内部已处理)。
- 命令行模式: 有交互/长驻命令(如 vim/top)不适用(30s 超时 kill); 不支持交互 stdin。

## 5. 后续规划

### 已完成
- [x] v0.5(08-08): 移除全部 agent 引擎与工具调用, 纯聊天 TUI
- [x] v0.6(08-09): Tab 命令行模式; Esc 不退出; 项目内 .minicode 缓存; Ctrl+x 复制/会话快捷键; 独立配置面板; install.sh 全局安装

### P0 — 稳定
- [ ] 真实 LLM 端到端人工验证

### P1 — 打磨
- [ ] token 用量显示(usage 已解析, TUI 未展示)
- [ ] 会话"恢复最近"交互选择器(当前 /sessions + 序号)
- [ ] 主题自动切换平滑化

### P3 — 工程化
- [ ] `pnpm link` 全局体验补测试 / CI 组合脚本
- [ ] 文档中的 dist 版本标记

## 6. 快速上手

```bash
cd ~/Code/MiniCode
pnpm install
pnpm typecheck && pnpm smoke && pnpm smoke:ui && pnpm smoke:tui   # 门禁
LLM_URL=<endpoint> LLM_API_KEY=<key> LLM_MODEL=<model> pnpm dev     # 本机 TUI
bash install.sh -y                                                # 全局安装
minicode                                                          # 任意目录可用(自动项目内 .minicode/)
```