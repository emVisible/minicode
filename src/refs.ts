// 消息输入快捷解析(对齐 opencode):
//   !cmd    —— 直接执行 shell 命令, 输出进对话(不走 LLM)
//   @path   —— 模糊引用文件: 匹配后读内容注入上下文
// 解析必须在提交前完成, 替换后的文本才是真正交给 LLM 的 prompt。

import { resolve } from "node:path"

// ---------- 文件索引(输入时 @ 实时补全用, 30s 缓存) ----------

let fileIndexCache: { cwd: string; files: string[]; ts: number } | null = null

/** 项目文件相对路径索引(git ls-files + glob 合并, 忽略 node_modules/.git/.tmp, 30s 缓存)。 */
export async function getFileIndex(cwd: string): Promise<string[]> {
  if (fileIndexCache && fileIndexCache.cwd === cwd && Date.now() - fileIndexCache.ts < 30_000) return fileIndexCache.files
  const files = new Set<string>()
  const { exec } = await import("node:child_process")
  const { promisify } = await import("node:util")
  // git 追踪文件(含未提交的)
  try {
    const { stdout } = await promisify(exec)("git ls-files -c -o --exclude-standard", { cwd, timeout: 3000 })
    for (const line of stdout.split("\n")) {
      const p = line.trim()
      if (p && !p.includes("node_modules")) files.add(p)
    }
  } catch {
    // 非 git 仓库 → 忽略
  }
  // glob 兜底: git ls-files 可能漏掉 gitignore 内/新目录文件, 总是再扫一遍合并
  try {
    const { glob } = await import("node:fs/promises")
    for await (const p of glob("**/*", { cwd, exclude: ["**/node_modules/**", "**/.git/**", "**/.tmp/**"] })) {
      files.add(p)
    }
  } catch {
    // glob 不可用 → 只依赖 git 列表
  }
  const list = [...files]
  fileIndexCache = { cwd, files: list, ts: Date.now() }
  return list
}

/** 输入中 @query 的实时补全候选(评分排序, 取前 limit)。 */
export async function matchAtCompletion(cwd: string, query: string, limit = 5): Promise<string[]> {
  if (!query) return []
  const files = await getFileIndex(cwd)
  const scored: Array<{ path: string; score: number }> = []
  for (const p of files) {
    const base = p.split("/").pop() ?? p
    const s = Math.max(scoreMatch(p, query), scoreMatch(base, query))
    if (s >= 0) scored.push({ path: p, score: s })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return scored.slice(0, limit).map((s) => s.path)
}

export interface ResolvedRef {
  /** 匹配到的绝对路径 */
  path: string
  /** 文件内容(≤50KB) */
  content: string
}

/** 从文本中提取所有 @ 引用 token(path 不含空格)。 */
export function extractAtRefs(text: string): string[] {
  const out: string[] = []
  const re = /(?:^|\s)@([^\s@"]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1]!)
  return out
}

/** 子序列评分: 越靠前越好(路径前缀命中更优)。 */
export function scoreMatch(candidate: string, query: string): number {
  let i = 0
  let j = 0
  let score = 0
  const c = candidate.toLowerCase()
  const q = query.toLowerCase()
  while (i < c.length && j < q.length) {
    if (c[i] === q[j]) {
      score += 1
      j++
    }
    i++
  }
  if (j < q.length) return -1 // 不是子序列
  // 前缀命中额外加分(用户通常敲文件名开头)
  if (c.startsWith(q)) score += 10
  return score
}

/**
 * 模糊匹配 cwd 下文件(git ls-files 优先, 回退全量 glob, 忽略 node_modules/.git)。
 * 返回按评分降序的匹配路径(最多 limit 个)。
 */
export async function fuzzyMatchFiles(cwd: string, query: string, limit = 8): Promise<string[]> {
  if (!query) return []
  const candidates = new Set<string>()
  const { exec } = await import("node:child_process")
  const { promisify } = await import("node:util")
  try {
    const { stdout } = await promisify(exec)("git ls-files", { cwd, timeout: 3000 })
    for (const line of stdout.split("\n")) {
      const p = line.trim()
      if (p && !p.includes("node_modules")) candidates.add(p)
    }
  } catch {
    // 非 git 仓库 → 回退 glob
    const { glob } = await import("node:fs/promises")
    for await (const p of glob("**/*", { cwd, exclude: ["**/node_modules/**", "**/.git/**", "**/.tmp/**"] })) {
      candidates.add(p)
    }
  }
  const scored: Array<{ path: string; score: number }> = []
  for (const p of candidates) {
    const base = p.split("/").pop() ?? p
    const s = Math.max(scoreMatch(p, query), scoreMatch(base, query))
    if (s >= 0) scored.push({ path: p, score: s })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return scored.slice(0, limit).map((s) => resolve(cwd, s.path))
}

/** 解析文本中的 @ 引用, 返回替换后的文本 + 已解析的引用。 */
export async function resolveRefs(cwd: string, text: string): Promise<{ text: string; refs: ResolvedRef[] }> {
  const tokens = extractAtRefs(text)
  if (!tokens.length) return { text, refs: [] }
  const { existsSync } = await import("node:fs")
  const { readFileSync } = await import("node:fs")
  const refs: ResolvedRef[] = []
  let out = text
  for (const token of tokens) {
    const direct = resolve(cwd, token)
    if (existsSync(direct)) {
      const content = readFileSync(direct, "utf8")
      if (content.length > 50 * 1024) continue
      refs.push({ path: direct, content })
      out = out.replace(`@${token}`, token)
      continue
    }
    const matches = await fuzzyMatchFiles(cwd, token, 1)
    if (!matches.length) continue
    const target = matches[0]!
    const { readFileSync: read } = await import("node:fs")
    const content = read(target, "utf8")
    if (content.length > 50 * 1024) continue
    refs.push({ path: target, content })
    out = out.replace(`@${token}`, token)
  }
  return { text: out, refs }
}
