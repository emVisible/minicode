# 交接与后续规划

> 时间: 2026-08-06
> 背景: Influx(声明式计划运行时)合并入 MiniCode(对话式编码 agent),统一到本仓库。
> 读者: 后续接手者 / 未来的自己。

## 1. 当前状态

MiniCode v0.3 = 对话 agent(M1 核心闭环)+ Influx 计划运行时,两个循环并存:

| 侧 | 循环 | 入口 | 工具 |
|---|---|---|---|
| 对话 | `runAgent`(loop.ts): LLM 决定调工具,逐轮回环 | `minicode` TUI / `--headless` | read/write/edit/glob/grep/bash + 桥接 http_get/http_post/llm |
| 计划 | `Runtime`(influx/core.ts): fiber 树 + reconcile diff + 波次并行 + 增量缓存 | `minicode plan run/bench/view` / `minicode mcp` | http.get/http.post/shell/write-file/read-file/list-dir/llm + registerTool |

所有验证全绿(合并当日实测):
- `pnpm typecheck`(双配置)→ 0 错误
- `pnpm smoke` → 8/8(对话侧假 LLM server 全链路)
- `pnpm smoke:influx` → SMOKE TEST PASSED(缓存/when/阻断/fallback/retry/自动key/重复key)
- `pnpm demo` → 并行 HTTP 3 节点 + 聚合 + 条件分支,`PASSED: total=6`
- 旧命令 `minicode run examples/shell.plan.tsx` 兼容 ✓,`minicode mcp` 启动 ✓

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

- **真实 LLM 端到端未验证**: 环境无 `LLM_URL`,对话侧只有假 server 冒烟。接真实模型: 配置 `LLM_URL`/`LLM_API_KEY` 后人工验证 TUI 一轮。
- 上下文整段回放,无压缩/截断策略(LLM_URL 稳定后可加,优先级高)。
- 对话侧工具**顺序执行**(代码已预留并行,未实现);`loop.ts` 中 `for (const call of calls)`。
- influx 的 `llm` 节点工具与对话侧 `llm.ts` 客户端是**两份实现**(influx 用 undici + 非流式;对话用 fetch + SSE)。合并它们(计划节点也用 `LLMClient`)是低风险重构。
- influx `http.*` 节点失败以 throw 为语义,无 4xx 结果返回;`llm` 节点无 tool_calls 能力(只能问一次)。
- `plan view` 可视化在浏览器面板无实时进度条细节、无重连;SSE 事件不落盘。
- MiniCode 仓库**尚无首个 commit**(git 分支 main,0 commits)。建议接手第一步就是提交基线。

## 5. 后续规划(按优先级)

### P0 — 基线稳定
- [ ] 提交首个 commit(git init 已有,仓库无历史)
- [ ] 接真实 LLM 人工验证对话 + 计划 `llm` 节点(`pnpm demo:llm`)
- [ ] 上下文压缩: 超长历史做摘要化或 truncate 策略(对话侧最痛的点)

### P1 — 双循环打通(本仓库的核心价值)
- [ ] **计划内嵌对话**: `llm` 节点升级为支持 tool_calls 的 agent 循环(计划节点里跑 `runAgent`,把对话侧能力带进声明式批处理)—— 这是"1+1>2"的关键一步
- [ ] 对话侧并行工具调用(`Promise.all` 替换顺序 for,loop.ts 已预留)
- [ ] `influx_plan/run` MCP 工具支持引用 MiniCode 的 agent 工具(read/write/edit/glob/grep/bash 进计划注册表,反向桥接)

### P2 — 工具层深统一(可选,回报递减)
- [ ] 定义统一 `ToolDef`,计划工具返回对象增加 `output` 派生字段,两套注册表合并成一个
- [ ] 风险: 会动 influx core 的 `resolveRefs`/结果提交语义与全部示例,收益主要是少一层适配。建议先做 P1,再评估。

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
