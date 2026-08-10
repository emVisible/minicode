// 命令注册表: 统一命名为 "/" 命令 + ctrl+x 领衔键 + 命令面板(Ctrl+P / 输入 "/")的唯一来源。
// 命令名即分发表; leader 键映射见 LEADER_KEYS; 面板展示见 PALETTE_GROUPS。

export type CommandGroup = "对话" | "配置" | "系统"

export interface CommandDef {
  name: string
  usage: string
  desc: string
  group: CommandGroup
  /** 面板右列展示的快捷键(如 ctrl+x n) */
  shortcut?: string
  aliases?: string[]
}

export const COMMANDS: CommandDef[] = [
  { name: "new", usage: "/new", desc: "新会话(清空当前)", group: "对话", shortcut: "ctrl+x n", aliases: ["clear", "reset"] },
  { name: "sessions", usage: "/sessions", desc: "历史会话列表 / 恢复", group: "对话", shortcut: "ctrl+x l", aliases: ["resume"] },
  { name: "copy", usage: "/copy", desc: "复制最后一条回答", group: "对话", shortcut: "ctrl+x c" },
  { name: "copyq", usage: "/copyq", desc: "复制我最近的问题", group: "对话", shortcut: "ctrl+x v" },
  { name: "editor", usage: "/editor", desc: "用外部编辑器撰写消息($EDITOR)", group: "对话", shortcut: "ctrl+x e" },
  { name: "export", usage: "/export", desc: "导出会话为 Markdown", group: "对话", shortcut: "ctrl+x x" },
  { name: "compact", usage: "/compact", desc: "长会话压缩成摘要", group: "对话" },
  { name: "fork", usage: "/fork", desc: "把当前会话复制为分支(新会话, 内容保留)", group: "对话" },
  { name: "connect", usage: "/connect", desc: "LLM 配置(URL / Key / 模型)", group: "配置", shortcut: "ctrl+o", aliases: ["config"] },
  { name: "themes", usage: "/themes", desc: "切换明暗主题(持久保存)", group: "配置", shortcut: "ctrl+x t" },
  { name: "dense", usage: "/dense", desc: "消息紧凑 / 宽松间距(持久保存)", group: "配置", shortcut: "ctrl+x g" },
  { name: "models", usage: "/models", desc: "当前模型信息", group: "配置", shortcut: "ctrl+x m" },
  { name: "usage", usage: "/usage", desc: "用量统计(会话 + 今日 + 累计)", group: "配置" },
  { name: "provider", usage: "/provider [名字]", desc: "切换 LLM provider(无参列出; 名字不存在则创建并切换)", group: "配置" },
  { name: "log", usage: "/log", desc: "查看日志文件", group: "配置" },
  { name: "mode", usage: "Tab", desc: "切换 对话 ↔ 命令行执行", group: "系统", shortcut: "tab" },
  { name: "help", usage: "/help", desc: "本面板即帮助", group: "系统", shortcut: "ctrl+p" },
  { name: "diag", usage: "/diag", desc: "诊断托盘", group: "系统", shortcut: "ctrl+x d" },
  { name: "quit", usage: "/quit", desc: "退出", group: "系统", shortcut: "ctrl+c ×2", aliases: ["exit", "q"] },
]

/** ctrl+x 领衔快捷键: ctrl+x 后 2 秒内按第二键 */
export const LEADER_KEYS: Record<string, string> = {
  n: "new",
  l: "sessions",
  t: "themes",
  m: "models",
  e: "editor",
  x: "export",
  c: "copy",
  v: "copyq",
  d: "diag",
  g: "dense",
  p: "help",
  q: "quit",
  "?": "help",
}

export const LEADER_TIMEOUT_MS = 2000

/** 面板过滤: query(已去掉前导 /)匹配 名字/别名/描述/快捷键; 空 query 返回全部 */
export function paletteMatches(query: string): CommandDef[] {
  const q = query.trim().toLowerCase()
  if (!q) return COMMANDS
  return COMMANDS.filter(
    (c) => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q) || c.aliases?.some((a) => a.includes(q)) || c.shortcut?.includes(q)
  )
}

/** 命令面板单屏行数上限(其余滚动) */
export const PALETTE_MAX_ROWS = 9

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
