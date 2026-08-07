// opencode 式命令注册表: / 命令 + ctrl+x 领衔快捷键的统一来源。
// 命令名即分发表; leader 键映射见 LEADER_KEYS。

export interface CommandDef {
  name: string
  usage: string
  desc: string
  aliases?: string[]
}

export const COMMANDS: CommandDef[] = [
  { name: "plan", usage: "/plan <任务>", desc: "拆解为 DAG 并并行执行" },
  { name: "vbuild", usage: "/vbuild <任务>", desc: "声明 → 执行: 先生成执行声明, 再按声明构建" },
  { name: "parallel", usage: "/parallel <N>", desc: "设置执行并发上限(默认 min(8, CPU 核))" },
  { name: "init", usage: "/init", desc: "分析项目生成 AGENTS.md" },
  { name: "editor", usage: "/editor", desc: "用外部编辑器撰写消息($EDITOR, 如 code --wait)" },
  { name: "export", usage: "/export", desc: "导出会话为 Markdown 文件" },
  { name: "compact", usage: "/compact", desc: "把长会话压缩成摘要(释放上下文)" },
  { name: "sessions", usage: "/sessions", desc: "会话列表 / 恢复", aliases: ["resume"] },
  { name: "undo", usage: "/undo", desc: "撤销上一轮文件改动" },
  { name: "redo", usage: "/redo", desc: "重做撤销" },
  { name: "new", usage: "/new", desc: "新会话(清空当前)", aliases: ["clear", "reset"] },
  { name: "details", usage: "/details", desc: "展开 / 收起全部节点详情" },
  { name: "connect", usage: "/connect", desc: "配置 LLM 提供方(URL / Key / 模型)", aliases: ["config"] },
  { name: "models", usage: "/models", desc: "当前模型信息" },
  { name: "themes", usage: "/themes", desc: "切换明暗主题" },
  { name: "log", usage: "/log", desc: "查看日志文件" },
  { name: "help", usage: "/help", desc: "命令列表" },
  { name: "quit", usage: "/quit", desc: "退出", aliases: ["exit", "q"] },
]

/** ctrl+x 领衔快捷键(对齐 opencode keybinds): ctrl+x 后 2 秒内按第二键 */
export const LEADER_KEYS: Record<string, string> = {
  u: "undo",
  r: "redo",
  n: "new",
  l: "sessions",
  t: "themes",
  m: "models",
  e: "editor",
  x: "export",
  c: "compact",
  d: "diag",
  p: "help",
  q: "quit",
  "?": "help",
}

export const LEADER_TIMEOUT_MS = 2000

/** 按输入文本找候选命令(用于 / 补全与分发)。 */
export function matchCommands(text: string): CommandDef[] {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return []
  const q = trimmed.slice(1).toLowerCase()
  return COMMANDS.filter((c) => (c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))) && q.length <= c.name.length + 1)
}

export function helpLines(): string[] {
  return COMMANDS.map((c) => `/${c.name}  —  ${c.desc}`)
}

/** /export 文件名(时间戳)。 */
export function transcriptName(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, "0")
  return `transcript-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.md`
}
