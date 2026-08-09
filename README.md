# MiniCode

Mini opencode: 一个终端里的对话式 LLM 聊天工具。核心链路(LLM SSE 客户端、会话管理、TUI)全部自研;第三方依赖仅限 UI 渲染(Ink/React)。

设计参考 opencode([anomalyco/opencode](https://github.com/anomalyco/opencode)) 的会话架构,做最小裁剪:

- **纯对话**: 模型只回文本, **不注册任何工具、不调用工具**——不读写文件、不执行命令
- **双模式**: Tab 切换 对话模式 ↔ 命令行模式(输入直接作为 shell 命令执行, 输出回显)
- 流式输出 + 打字机渲染 + 会话持久化 + 主题切换 + 剪贴板复制

配置通过 `LLM_URL` / `LLM_API_KEY` / `LLM_MODEL` 环境变量,或独立设置面板(`Ctrl+o`, 首启自动打开),持久化到项目内 `.minicode/config.json`。

## 已实现(v0.6)

### 交互与快捷键

- **Ctrl+C 双击退出**(唯一退出方式): 忙碌时单次取消请求, 3s 内再按退出
- **Esc 只取消不退出**: 关闭面板/中断请求/退出命令行模式; 绝不退出(用户要求: 防止误触)
- **Tab 切换 对话/命令行 模式**: 命令行模式输入直接作为 shell 命令执行(`cwd` 运行, 30s 超时熔断, 输出回显为结论块); 自动阻止"在命令行模式里再起 minicode"的嵌套
- **Ctrl+x 领衔快捷键**: `n`新会话 `l`会话列表·切换 `t`主题 `m`模型 `e`编辑器 `c`复制最后回答 `v`复制我的问题 `x`导出 `d`诊断 `?`帮助 `q`退出
- **剪贴板复制**(`src/clipboard.ts`): mac pbcopy / win clip / linux xclip-xsel 自动适配
- **独立配置面板**(`Ctrl+o` / `/config`): URL/Key/Model 三字段表单, 保存即生效(直接覆写进程 env)
- **首启引导**: 未配置 LLM 连接时自动打开配置面板, 无需记命令行

### 项目内缓存

- 数据目录 `<cwd>/.minicode/`(`MINICODE_HOME` 可覆盖): 配置/会话/日志全部项目内, 多项目隔离
- 启动自动创建; 会话防抖 800ms 落盘 `.minicode/sessions/`; `/sessions` 列表并恢复; `-r/--resume` 恢复最近
- 日志 `.minicode/logs/minicode-YYYYMMDD.log`(按天 + 2MB 轮转); 崩溃兜底; TUI 内 `/log` 回显

### 对话 LLM

- **LLM 流式客户端**(`src/llm.ts`): SSE 解析 `content` delta, 超时/退避重试/AbortSignal 中断, OpenAI Chat Completions 兼容; 兼容非流式 JSON 返回
- **无工具回环**: 单次请求 → 流式回复, 不解析 tool_calls(模型返回也忽略)
- **上下文管理**: 历史累积会话内; `/compact` 一次 LLM 调用压缩摘要
- TUI(headless 模式 + 非 TTY 自动退化)、打字机渲染、Markdown 渲染、主题 dark/light、IME 安全输入行、鼠标滚轮

### 安装(全局)

```
bash install.sh            # 交互安装
bash install.sh -y         # 全自动(默认 ~/.local/bin)
bash install.sh --prefix=/path
bash install.sh uninstall  # 卸载
```

任意目录下 `minicode` 会自动在**当前项目**创建 `.minicode/` 缓存(会话/配置/日志)。

## 使用

```
pnpm dev                                    # 交互 TUI
pnpm headless -- "你好"                       # 一次性对话
echo "你好" | pnpm headless                   # 管道输入
minicode                # 全局安装后任意目录
```

环境变量(也可在 TUI 设置面板配置,持久化到 `.minicode/config.json`):

```
LLM_URL=兼容 /chat/completions 的端点(必填)
LLM_API_KEY=Bearer token(可选)
LLM_MODEL=模型名(默认 "gpt-4o-mini")
MINICODE_HOME=数据目录覆盖(默认 <pwd>/.minicode/)
```

## 架构

```
src/
  cli.ts             统一入口(TUI / --headless / --cwd / -r; 确保项目 .minicode/)
  types.ts            共享类型(消息/流事件/会话消息)
  llm.ts              SSE 流式客户端(零网络库, 自解析, 退避重试)
  config.ts           用户配置(.minicode/config.json, 原子写/防御/0600/env 优先)
  prompt.ts           系统提示词(纯对话)
  session.ts          会话持久化(save/list/load/delete/resume)
  paths.ts            数据目录统一解析(MINICODE_HOME → <cwd>/.minicode)
  log.ts              日志体系(分级/落盘/轮转/崩溃兜底)
  clipboard.ts        剪贴板适配(pbcopy/clip/xclip)
  console-patch.ts    TUI 期间 console.* 重定向到日志
  commands.ts         命令注册表 + ctrl+x 领衔键
  ui/app.tsx          TUI 主(消息流/打字机/Ctrl+C/Esc 语义/双模式/命令分发)
  ui/settings.tsx     独立配置面板
  ui/welcome.tsx      欢迎卡片
scripts/build.mjs      esbuild 单文件打包(dist/minicode.mjs)
install.sh            交互安装(构建 + 全局注册 + PATH)
```

## 验证门禁

```
pnpm typecheck && pnpm smoke && pnpm smoke:ui && pnpm smoke:tui
```

- smoke: 路径解析(MINICODE_HOME)/配置原子写·权限·往返·env 优先/SSE 聚合/上下文/重试/非流式/中断/会话 CRUD(20 断言)
- ui-utils: 视口/滚动/命令表/鼠标(14 断言)
- tui-e2e: 真 PTY 驱动 —— 消息→流式回答→落盘→双击退出;Esc 不退出;Tab 命令行模式执行(10 断言)

## 未实现(明确不做/后续)

- 工具调用(read/write/bash/webfetch)—— 设计上就是纯聊天,永不引入
- 上下文语义压缩(当前仅 LLM 摘要)
- 多 provider 协议(non-OpenAI)/图片输入