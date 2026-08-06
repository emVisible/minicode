# 交接与后续规划

> 时间: 2026-08-06(基线) · 2026-08-06(v0.4 双引擎打通)
> 背景: Influx(声明式计划运行时)合并入 MiniCode(对话式编码 agent),统一到本仓库。
> 读者: 后续接手者 / 未来的自己。
> 长期路线: 见 ROADMAP(北极星 = 双引擎一体化; 声明式计划语言为差异化灵魂)。

## 1. 当前状态

MiniCode v0.4 = 对话 agent(核心闭环 + 并行工具 + 上下文压缩)+ Influx 计划运行时(计划内嵌对话已打通):

| 侧 | 循环 | 入口 | 工具 |
|---|---|---|---|
| 对话 | `runAgent`(loop.ts): LLM 决定调工具, 并行回环 | `minicode` TUI / `--headless` | read/write/edit/glob/grep/bash + 桥接 http_get/http_post/llm |
| 计划 | `Runtime`(influx/core.ts): fiber 树 + reconcile diff + 波次并行 + 增量缓存 | `minicode plan run/bench/view` / `minicode mcp` | http.get/http.post/shell/write-file/read-file/list-dir/llm(含 agent 模式) + agent.* 桥接 + registerTool |

v0.4 验证全绿(实测):
- `pnpm typecheck`(双配置)→ 0 错误
- `pnpm smoke` → 8/8(对话侧假 LLM server 全链路)
- `pnpm smoke:influx` → SMOKE TEST PASSED(含新增 llm 节点 agent 模式 tool_calls 回环断言)
- 假 LLM server 端到端跑通 `pnpm demo:agent`(read+bash 并行回环, steps=2)

## 2. 关键设计决策(改前必读)

1. **根 tsconfig `"jsx": "preserve"`(不是 react-jsx)**
   - 原因(已实测验证): tsx/esbuild 对整条构建链只用一个 tsconfig;若用 `react-jsx`,计划文件的 `/** @jsx task */` pragma 会被忽略,esbuild 改为自动 import `react/jsx-runtime`,运行时直接崩。
   - 代价: app.tsx 必须 `import React from "react"`(经典工厂 `React.createElement`);@types/react 19 不再声明全局 JSX,所以加了 `src/ui/react-jsx.d.ts` 桥接 `React.JSX`。
2. **类型检查拆两个 TS 程序**,避免全局 JSX 命名空间冲突:
   - `tsconfig.json`: 应用+测试,含 `src/ui/react-jsx.d.ts`,exclude `examples` 和 `src/influx/jsx.d.ts`
   - `tsconfig.plans.json`: 计划文件,含 `src/influx/jsx.d.ts`,不含 React
   - 新计划文件必须放在 `examples/`,不要放 `src/` 下(否则计划 JSX 类型与 React 冲突)。
3. **两套工具层未强行统一**: 计划工具返回结构化对象(给 `$key.path` 引用),对话工具返回 `{output: string}`(回喂模型)。桥接方向是对话侧消费计划工具(`http_get`/`http_post`/`llm` 三个 ToolDef 包 `influx getTool`)。反向(计划节点用 agent 工具)未做,原因见规划 P2。
4. **`noUncheckedIndexedAccess` 全开**: influx core.ts 迁入时改了几处正则索引(加 `!` 断言),语义未变;后续改 influx 代码注意这个严格模式。
5. **原 Influx 目录保留为归档**(`~/Code/Influx`,无 .git,内容未删): obsidian-docs-bridge 及其示例计划 `obsidian-bridge.plan.tsx` 留在那里,本仓库不引用。合入后 Influx 与 MiniCode 已分叉,若再改 Influx 运行时,以本仓库 `src/influx/` 为准。

## 3. 文件索引

```
src/influx/core.ts       运行时本体(fiber/reconcile/波次/缓存/值引用/when 求值器)—— 693 行,核心
src/influx/tools.ts      计划节点工具注册表(registerTool/getTool/listTools)
src/influx/plan-cli.ts   plan run/bench/view 实现(printReport/printTree/serializeTree 都在这里)
src/influx/mcp.ts        MCP 服务器(influx_tools/plan/run/state/result/reset)
src/influx/view.html     浏览器可视化面板(SSE)
src/cli.ts               统一入口(子命令分发逻辑)
src/tools.ts             对话工具 + influx 桥接(文件底部 influxTool 工厂)
src/ui/react-jsx.d.ts    全局 JSX shim
tsconfig.plans.json      计划程序类型检查
test/influx-smoke.ts     MCP 冒烟(StdioClientTransport 驱动,覆盖 14 个场景)
examples/*.plan.tsx      4 个可跑示例(demo/shell/fs-demo/llm-demo)
```

## 4. 已知限制 / 技术债

- **真实 LLM 端到端未验证**: 环境无 `LLM_URL`,对话侧与计划 agent 模式只有假 server 冒烟。接真实模型: TUI 内 `Ctrl+o` 设置面板配置,或注入 `LLM_URL` 后人工验证 TUI 一轮 + `pnpm demo:agent`。
- 上下文压缩是**体积截断**(丢最旧+标记),无语义摘要(摘要化列为 W2)。
- influx 的 `llm` 节点与对话侧已共用 `LLMClient`(v0.4 合并),但 `http.*` 节点仍走 undici(与对话侧 fetch 双栈,低风险)。
- influx `http.*` 节点失败以 throw 为语义,无 4xx 结果返回。
- **计划侧权限模型缺失**: `plan run` 默认对 shell/write-file 与 agent.* 工具全放行(ask 默认 true)。对话侧有确认,计划侧没有 —— 权限统一是路线图 W2 项。
- `plan view` 可视化在浏览器面板无实时进度条细节、无重连;SSE 事件不落盘。
- MCP `influx_run` 无 AbortSignal/取消;状态仅进程内生命周期。
- 两个 tsconfig 程序并存: 新计划文件必须放 `examples/`(JSX 类型冲突)。
- `--cwd` 无等号 bug 已修复(v0.4);headless 在 TTY 下可交互确认,管道下仍默认拒绝。
- 设置面板尚无 provider 端点下拉/模型列表(纯手动输入);API Key 在编辑态明文显示(失焦掩码)。

## 5. 后续规划(按优先级;长期波次见 ROADMAP)

### 已完成(v0.4)
- [x] 提交首个 commit(2026-08-06 基线 `25533b8`)
- [x] 上下文压缩(体积截断版)
- [x] 计划内嵌对话: `llm` 节点 agent 模式(计划节点里跑 `runAgent`)
- [x] 对话侧并行工具调用(`Promise.all`)
- [x] 反向桥接: 对话工具进计划注册表(`agent.*`),llm 节点 tools 参数走同一份 ToolDef
- [x] 合并两份 LLM 实现(influx llm 节点复用 `LLMClient`)
- [x] `--cwd` 无等号 bug、headless TTY 确认、TUI 多 ask 排队
- [x] 删除死代码(ContentDelta / LoopOutcome / 未用 StreamEvent 变体)
- [x] TUI 内置设置面板(`Ctrl+o` / `/config`): 配置 LLM URL/API Key/Model,保存即生效,持久化 `~/.minicode/config.json`(原子写 + 0600 + 防御加载 + env 优先)

### P0 — 基线稳定
- [ ] 接真实 LLM 人工验证对话 + 计划 agent 模式(`pnpm demo:agent`)

### P1 — 双循环深化(本仓库的核心价值)
- [ ] 会话 ⇄ 计划互转: 对话导出为 plan.tsx,计划可进入对话继续演进(ROADMAP W3)
- [ ] `influx_plan/run` MCP 工具已可引用 agent 工具(桥接完成),补 MCP 端 agent 模式 e2e 断言

### P2 — 工具层深统一(可选,回报递减)
- [ ] 统一 `ToolDef`,计划工具返回对象增加 `output` 派生字段,两套注册表合并成一个
- [ ] 风险: 会动 influx core 的 `resolveRefs`/结果提交语义与全部示例。v0.4 已用桥接+懒加载规避循环依赖,收益评估中。

### P3 — 工程化
- [ ] `pnpm build`(tsc emit 或 esbuild bundle)+ bin 安装(`pnpm link`),脱离 tsx
- [ ] 计划文件的 CLI 子命令补全: `plan new <name>` 脚手架、`plan validate`(只跑 preview 不执行)
- [ ] influx smoke 补一个 `plan view` 的 SSE 端到端断言(当前只有手动验证)
- [ ] `when` 表达式求值器补单元测试(它是手写解析器,最容易被改坏)
- [ ] MCP 服务器支持 `LLM_URL` 场景的端到端(计划内 llm 节点走真实/假 server 已在 smoke 覆盖,但 agent 会话进 MCP 没有)

## 6. 快速上手

```bash
cd ~/Code/MiniCode
pnpm install
pnpm typecheck && pnpm smoke && pnpm smoke:influx   # 门禁
pnpm demo                                            # 计划: 并行 HTTP + 聚合 + 条件
pnpm demo:rerun                                      # 增量缓存验证
pnpm dev                                             # 对话 TUI(需 LLM_URL)
```

写一个新的计划: 复制 `examples/shell.plan.tsx`,文件头必须保留 `/** @jsx task */`,放 `examples/` 下,`pnpm plan:run examples/xxx.plan.tsx` 运行。
