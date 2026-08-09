// 会话持久化 —— 对齐 opencode 的会话管理基础能力
//
// 对话(结构化消息 + LLM 历史)落盘到 <项目>.minicode/sessions/(MINICODE_HOME 可覆盖),
// 支持: 列表查看 / 按序号恢复 / 启动 --resume 自动恢复最近会话。
// 文件: {ts}-{slug}.json, 内容 {cwd, model, createdAt, msgs, history}

import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ChatMsg, ChatMessage } from "./types.ts"
import { sessionsDir as resolveSessionsDir } from "./paths.ts"

export interface SessionRecord {
  id: string
  cwd: string
  model: string
  createdAt: number
  msgs: ChatMsg[]
  history: ChatMessage[]
}

function sessionsDir(): string {
  return resolveSessionsDir()
}

function slug(cwd: string): string {
  const base = cwd.split("/").filter(Boolean).at(-1) ?? "session"
  return base.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24)
}

/** 保存当前会话(覆盖同 id 已有文件) */
export function saveSession(s: SessionRecord): void {
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(join(sessionsDir(), `${s.id}.json`), JSON.stringify(s, null, 1), "utf8")
  } catch {
    // 持久化失败不阻塞主流程
  }
}

/** 列出全部会话(按创建时间倒序, 只读元信息) */
export function listSessions(): Array<{ id: string; cwd: string; createdAt: number; firstMsg: string; msgs: number }> {
  try {
    return readdirSync(sessionsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const id = f.replace(/\.json$/, "")
        try {
          const raw = JSON.parse(readFileSync(join(sessionsDir(), f), "utf8")) as SessionRecord
          return {
            id,
            cwd: raw.cwd,
            createdAt: raw.createdAt,
            firstMsg: raw.msgs.find((m) => m.kind === "user")?.text.slice(0, 60) ?? "(空会话)",
            msgs: raw.msgs.length,
          }
        } catch {
          return null
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

/** 加载指定会话 */
export function loadSession(id: string): SessionRecord | null {
  try {
    const raw = readFileSync(join(sessionsDir(), `${id}.json`), "utf8")
    const s = JSON.parse(raw) as SessionRecord
    if (!Array.isArray(s.msgs)) return null
    return s
  } catch {
    return null
  }
}

/** 最近一次会话(--resume 用) */
export function latestSession(): SessionRecord | null {
  const list = listSessions()
  if (!list.length) return null
  return loadSession(list[0]!.id)
}

/** 删除会话 */
export function deleteSession(id: string): void {
  try {
    rmSync(join(sessionsDir(), `${id}.json`), { force: true })
  } catch {
    // ignore
  }
}

/** 生成会话 id(时间戳 + cwd 简称) */
export function newSessionId(cwd: string): string {
  return `${Date.now()}-${slug(cwd)}`
}

/** 会话文件目录(展示用) */
export function sessionsDirPath(): string {
  return sessionsDir()
}

/** 最近 N 天内的会话是否早于阈值(用于自动清理提示; 暂不自动删) */
export function sessionFileCount(): number {
  try {
    return readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")).length
  } catch {
    return 0
  }
}
