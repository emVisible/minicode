// AGENTS.md 项目上下文 —— 对齐 opencode 的项目规则机制
//
// 与 Axiom 同构: 动态读取项目根 AGENTS.md(用户/团队维护的项目专属规则),
// 每次构建系统提示词按 mtime 重读, 更新后自动生效; 不写死、不缓存快照。
// cap 32KB, 防止超大文件撑爆上下文; /init 命令负责生成/刷新这份文件。

import { readFileSync, existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { log } from "./log.ts"

const MAX_BYTES = 32 * 1024

let cachedMtime = 0
let cachedContent = ""

/** 定位项目根的 AGENTS.md(优先 cwd, 逐级向上找) */
export function agentsMDPath(cwd: string): string {
  const candidates = [
    resolve(cwd, "AGENTS.md"),
    resolve(cwd, "..", "AGENTS.md"),
    resolve(cwd, "..", "..", "AGENTS.md"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]!
}

/** 读取当前 AGENTS.md(动态, mtime 失效) */
function readAgentsMD(cwd: string): string {
  const p = agentsMDPath(cwd)
  try {
    const st = statSync(p)
    if (st.mtimeMs !== cachedMtime) {
      cachedContent = readFileSync(p, "utf8")
      cachedMtime = st.mtimeMs
      log.info("agentsmd", "加载 AGENTS.md", { path: p, bytes: cachedContent.length })
    }
    return cachedContent
  } catch {
    return ""
  }
}

/** 注入系统提示词的 AGENTS.md 块(不存在/超限 → 空串) */
export function agentsMDPromptBlock(cwd: string): string {
  const content = readAgentsMD(cwd)
  if (!content) return ""
  if (content.length > MAX_BYTES) {
    log.warn("agentsmd", "AGENTS.md 超过 32KB, 未注入(模型可按需读取)", { bytes: content.length })
    return ""
  }
  return `[项目规则 · AGENTS.md]\n${content.trim()}`
}
