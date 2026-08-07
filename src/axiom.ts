// Axiom 基准原则 —— 嵌入 session 的底层基调(动态, 不写死)
//
// 真相源: 仓库根目录 axiom.md —— 用户长期维护、持续更新的从书式 AI 长期协作体系。
// 本模块绝不冻结快照: 每次构建系统提示词时都按 mtime 重新读取文件,
// 文档更新后, 新 session 自动使用最新版本(同进程内 mtime 缓存失效)。
//
// 注入模式(MINICODE_AXIOM):
//   core(默认)  动态提取「第一部 · 从书式长期协作提示词」—— 文档自述的
//               "执行文件, 可直接载入系统提示词" 层(约 6K token)
//   full        全文注入(完整约束, 上下文开销大; >400KB 拒绝)
//   none        不注入
// MINICODE_AXIOM_PATH 可显式指定 axiom.md 路径(多项目复用/测试)。

import { readFileSync, existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { log } from "./log.ts"

export type AxiomMode = "core" | "full" | "none"

const MAX_FULL_BYTES = 400 * 1024

export function resolveAxiomMode(): AxiomMode {
  const v = (process.env.MINICODE_AXIOM ?? "core").toLowerCase()
  if (v === "full" || v === "none") return v
  return "core"
}

/** 定位 axiom.md: 显式路径 > 仓库根(相对本模块) > cwd */
export function axiomPath(): string {
  const explicit = process.env.MINICODE_AXIOM_PATH
  if (explicit) return explicit
  const here = new URL("..", import.meta.url).pathname
  const candidates = [resolve(here, "axiom.md"), resolve(process.cwd(), "axiom.md")]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]!
}

/** 按 mtime 缓存: 文件更新后自动重读(同一进程内多 session 也拿到最新) */
let cachedMtime = 0
let cachedContent = ""

/** 读取当前 axiom.md(动态, 无快照) */
function readAxiom(): string {
  const p = axiomPath()
  try {
    const st = statSync(p)
    if (st.mtimeMs !== cachedMtime) {
      cachedContent = readFileSync(p, "utf8")
      cachedMtime = st.mtimeMs
      log.info("axiom", "加载 axiom.md", { path: p, bytes: cachedContent.length, mode: resolveAxiomMode() })
    }
    return cachedContent
  } catch {
    return ""
  }
}

/**
 * 动态提取「第一部 · 从书式长期协作提示词」—— 文档自述可直接载入系统提示词
 * 的执行层(自知与求真/存在底色/认知框架/行动协议/场景加载/输出风格/自检/传承)。
 * 标题结构变化时回退: 取全文前 40KB, 保证永远有内容。
 */
function extractExecutablePart(text: string): string {
  const start = text.indexOf("# 第一部")
  if (start === -1) {
    return text.slice(0, 40 * 1024).trim() || "(axiom.md 为空)"
  }
  const end = text.indexOf("# 第二部", start)
  const part = end > start ? text.slice(start, end) : text.slice(start)
  const trimmed = part.trim()
  return trimmed || "(axiom.md 第一部为空)"
}

/** 注入系统提示词: 按模式返回当前 axiom.md 的内容(动态读取) */
export function axiomPromptBlock(): string {
  const mode = resolveAxiomMode()
  if (mode === "none") return ""
  const full = readAxiom()
  if (!full) {
    log.warn("axiom", "axiom.md 不可读, 未注入基准原则", { path: axiomPath() })
    return ""
  }
  if (mode === "full") {
    if (full.length > MAX_FULL_BYTES) {
      log.warn("axiom", "axiom.md 超过 400KB, 拒绝全文注入", { bytes: full.length })
      return extractExecutablePart(full)
    }
    return full
  }
  return extractExecutablePart(full)
}
