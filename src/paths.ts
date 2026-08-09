// 路径解析 —— 项目内缓存(.minicode/)优先, MINICODE_HOME 可显式覆盖
//
// 约定:
//   - MINICODE_HOME 已设置 → 用它作为用户数据目录
//   - 否则默认 <cwd>/.minicode/(项目内缓存, 会话/配置/日志都在这里, 可 git 忽略)
// 所有组件(config/log/session)动态读取, 不要在模块顶层缓存路径。

import { join } from "node:path"
import { homedir } from "node:os"
import { mkdirSync } from "node:fs"

/** 用户数据根目录(.minicode/) */
export function homePath(cwd?: string): string {
  const over = process.env.MINICODE_HOME
  if (over && over.trim()) return over.trim()
  return join(cwd ?? process.cwd(), ".minicode")
}

/** 配置文件路径(~/.minicode/config.json 或 <.minicode>/config.json) */
export function configFile(cwd?: string): string {
  return join(homePath(cwd), "config.json")
}

/** 会话目录 */
export function sessionsDir(cwd?: string): string {
  return join(homePath(cwd), "sessions")
}

/** 日志目录 */
export function logsDir(cwd?: string): string {
  return join(homePath(cwd), "logs")
}

/** 确保用户数据目录结构存在(幂等) */
export function ensureHome(cwd?: string): void {
  const base = homePath(cwd)
  try {
    mkdirSync(base, { recursive: true })
  } catch {
    // 失败不影响主流程
  }
}

/** 兼容旧全局位(仅用于提示展示) */
export function legacyHome(): string {
  return join(homedir(), ".minicode")
}