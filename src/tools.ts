// 内置工具注册表: read / write / bash —— M1 最小集
// 输出统一为字符串(直接回喂模型); 读类 allow, 写/bash 默认 ask(由 UI 决定)

import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import type { ToolDef } from "./types.ts"
import { getTool as getInfluxTool } from "./influx/tools.ts"

const exec = promisify(execCb)

const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024

function truncateText(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `\n...(输出过长已截断, 共 ${s.length} 字符)` : s
}

// ---------- read ----------

const readTool: ToolDef = {
  name: "read",
  description:
    "读取文件内容(带行号)或列出目录。参数: path(必填, 绝对路径或相对当前目录), offset(起始行, 从 1 计, 可选), limit(最大行数, 默认 2000)。文件超过 50KB 会截断并提示继续读取。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件或目录的路径(绝对或相对 cwd)" },
      offset: { type: "number", description: "起始行号(1 起), 默认 1" },
      limit: { type: "number", description: "最大读取行数, 默认 2000" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const { readFileSync, readdirSync, existsSync, statSync } = await import("node:fs")
    const { resolve, dirname } = await import("node:path")
    const rawPath = String(args.path ?? "")
    if (!rawPath) throw new Error("[read] 缺少 path 参数")
    const filepath = resolve(ctx.cwd, rawPath)
    // VBuild 模式: 优先读 overlay(构建中的世界), 无则回退磁盘
    if (ctx.vfs) {
      if (ctx.vfs.has(filepath)) {
        try {
          const content = ctx.vfs.read(filepath)
          const lines = content.split("\n")
          const offset = Number(args.offset ?? 1)
          const limit = Number(args.limit ?? MAX_READ_LINES)
          const start = Math.max(0, offset - 1)
          const slice = lines.slice(start, start + limit)
          const body = slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n")
          return {
            output: `<path>${filepath}</path>\n<type>vfs</type>\n<content>\n${body}\n</content>\n(虚拟层, 共 ${lines.length} 行, 显示 ${start + 1}-${start + slice.length})`,
          }
        } catch {
          // overlay 标记删除 → 回退磁盘语义报"不存在"
        }
      } else {
        return {
          output: `<path>${filepath}</path>\n<type>vfs</type>\n<content>(虚拟构建中不存在)</content>\n(尚未创建)`,
        }
      }
    }
    if (!existsSync(filepath)) {
      const parent = dirname(filepath)
      const guess = (readdirSync(parent, { withFileTypes: true }).filter((e) =>
        e.name.toLowerCase().includes(filepath.split("/").at(-1)?.toLowerCase() ?? ""),
      ) || [])
        .slice(0, 3)
        .map((e) => e.name)
      throw new Error(`文件不存在: ${filepath}${guess.length ? `\n相似条目: ${guess.join(", ")}` : ""}`)
    }
    if (statSync(filepath).isDirectory()) {
      // 带大小/类型的目录列表: 模型无需重复读目录就能判断下一步(减少重复 read 导致的死循环误判)
      const entries = readdirSync(filepath, { withFileTypes: true })
        .slice(0, MAX_READ_LINES)
        .map((e) => {
          const p = `${filepath}/${e.name}`
          if (e.isDirectory()) return `${e.name}/ (dir)`
          try {
            return `${e.name} (${statSync(p).size}B)`
          } catch {
            return `${e.name} (?)`
          }
        })
      return {
        output: `<path>${filepath}</path>\n<type>directory</type>\n<entries>\n${entries.join("\n")}\n</entries>\n(共 ${readdirSync(filepath).length} 项, 显示前 ${entries.length} 项, 每项带大小)` ,
      }
    }
    const size = statSync(filepath).size
    if (size > MAX_READ_BYTES) {
      return {
        output: `文件过大(${size} 字节 > 50KB), 请用 bash/head 或指定 offset/limit 分段读取。`,
      }
    }
    const lines = readFileSync(filepath, "utf8").split("\n")
    const offset = Number(args.offset ?? 1)
    const limit = Number(args.limit ?? MAX_READ_LINES)
    const start = Math.max(0, offset - 1)
    const slice = lines.slice(start, start + limit)
    const body = slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n")
    return {
      output: `<path>${filepath}</path>\n<type>file</type>\n<content>\n${body}\n</content>\n(共 ${lines.length} 行, 显示 ${start + 1}-${start + slice.length} 行${slice.length < lines.length - start ? ", 可传 offset 继续" : ""})`,
    }
  },
}

// ---------- write ----------

const writeTool: ToolDef = {
  name: "write",
  description:
    "写文件(覆盖), 自动创建父目录。参数: path(必填), content(必填)。用于新建或整体重写文件; 局部修改应先用 read 读原文。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径(绝对或相对 cwd)" },
      content: { type: "string", description: "完整文件内容" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const { mkdirSync, writeFileSync, statSync } = await import("node:fs")
    const { resolve, dirname } = await import("node:path")
    const path = String(args.path ?? "")
    const content = String(args.content ?? "")
    if (!path) throw new Error("[write] 缺少 path 参数")
    const filepath = resolve(ctx.cwd, path)
    const ok = await ctx.ask({
      tool: "write",
      summary: `${filepath} (${Buffer.byteLength(content)} 字节)`,
    })
    if (!ok) throw new Error("[write] 用户拒绝了写文件")
    // VBuild 模式: 写入内存 overlay, RBuild 阶段统一并行落盘
    if (ctx.vfs) {
      ctx.vfs.write(filepath, content)
      return { output: `[vbuild] 已暂存 ${filepath} (${Buffer.byteLength(content)} 字节, 待 RBuild 落盘)` }
    }
    mkdirSync(dirname(filepath), { recursive: true })
    writeFileSync(filepath, content, "utf8")
    return { output: `已写入 ${filepath} (${statSync(filepath).size} 字节)` }
  },
}

// ---------- bash ----------

const bashTool: ToolDef = {
  name: "bash",
  description:
    "在 shell 中执行命令并返回 stdout/stderr。参数: cmd(必填, 完整 shell 命令), timeoutMs(超时, 默认 30000)。适合跑测试、git、构建; 改代码用 read/write。",
  parameters: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "要执行的 shell 命令" },
      timeoutMs: { type: "number", description: "超时毫秒数, 默认 30000" },
    },
    required: ["cmd"],
  },
  async execute(args, ctx) {
    const cmd = String(args.cmd ?? "")
    if (!cmd) throw new Error("[bash] 缺少 cmd 参数")
    const ok = await ctx.ask({
      tool: "bash",
      summary: cmd.slice(0, 120),
    })
    if (!ok) throw new Error("[bash] 用户拒绝了命令执行")
    const { stdout, stderr } = await exec(cmd, {
      timeout: Number(args.timeoutMs ?? 30000),
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    return {
      output: truncateText(
        [stdout.trim() ? `[stdout]\n${stdout.trim()}` : "", stderr.trim() ? `[stderr]\n${stderr.trim()}` : ""]
          .filter(Boolean)
          .join("\n") || "(无输出)",
      ),
    }
  },
}

// ---------- glob ----------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".out", ".next", ".cache"])

/** 将 glob pattern(支持 ** * ? )转成正则 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const re = escaped
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLESTAR__/g, ".*")
  return new RegExp("^" + re + "$")
}

const globTool: ToolDef = {
  name: "glob",
  description:
    "按 glob 模式列出匹配的文件/目录(相对 cwd)。参数: pattern(必填, 如 'src/**/*.ts'), cwd(起始目录, 默认当前工作目录)。自动跳过 node_modules。最多返回 200 条。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式, 支持 **/*/?" },
      cwd: { type: "string", description: "起始目录(默认工作目录)" },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const { readdir, stat } = await import("node:fs/promises")
    const { resolve, join, relative } = await import("node:path")
    const pattern = String(args.pattern ?? "")
    const cwd = resolve(ctx.cwd, String(args.cwd ?? "."))
    if (!pattern) throw new Error("[glob] 缺少 pattern 参数")
    const re = globToRegExp(pattern)
    const results: string[] = []

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= 200) return
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (results.length >= 200) return
        const abs = join(dir, name)
        const rel = relative(cwd, abs) || "."
        let isDir = false
        try {
          isDir = (await stat(abs)).isDirectory()
        } catch {
          continue
        }
        if (isDir) {
          if (SKIP_DIRS.has(name)) continue
          if (re.test(rel)) results.push(rel + "/")
          await walk(abs)
        } else if (re.test(rel)) {
          results.push(rel)
        }
      }
    }
    await walk(cwd)

    if (results.length === 0) {
      try {
        for (const name of await readdir(cwd)) {
          const rel = name
          if (re.test(rel)) results.push(rel)
        }
      } catch {}
    }
    results.sort()
    if (results.length === 0) return { output: "(无匹配文件)" }
    return { output: results.join("\n") + (results.length >= 200 ? "\n(已截断至 200 条)" : "") }
  },
}

// ---------- grep ----------

const MAX_GREP_RESULTS = 200
const MAX_GREP_FILE_BYTES = 1024 * 1024

const grepTool: ToolDef = {
  name: "grep",
  description:
    "在起始目录下递归搜索文件内容, 返回 '路径:行号: 行文本'。参数: pattern(必填, 正则), path(默认当前工作目录), includeFilter(可选, 只搜索匹配该字符串的文件名)。自动跳过 node_modules。最多 200 条。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "起始目录" },
      includeFilter: { type: "string", description: "文件名包含的子串过滤" },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const { readdir, readFile, stat } = await import("node:fs/promises")
    const { resolve, join, relative, extname } = await import("node:path")
    const pattern = String(args.pattern ?? "")
    if (!pattern) throw new Error("[grep] 缺少 pattern 参数")
    const re = new RegExp(pattern)
    const root = resolve(ctx.cwd, String(args.path ?? "."))
    const includeFilter = args.includeFilter ? String(args.includeFilter) : undefined
    const results: string[] = []

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= MAX_GREP_RESULTS) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= MAX_GREP_RESULTS) return
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          await walk(abs)
          continue
        }
        if (includeFilter && !entry.name.includes(includeFilter)) continue
        try {
          const size = (await stat(abs)).size
          if (size === 0 || size > MAX_GREP_FILE_BYTES) continue
          const content = await readFile(abs, "utf8")
          const rel = relative(root, abs)
          content.split("\n").forEach((line, i) => {
            const m = line.match(re)
            if (m) {
              const col = m.index !== undefined ? m.index + 1 : 1
              const snippet = line.length > 160 ? line.slice(0, 160) + "…" : line
              results.push(`${rel}:${i + 1}:${col}: ${snippet.trim()}`)
            }
          })
        } catch {}
      }
    }
    await walk(root)
    if (results.length === 0) return { output: "(无匹配)" }
    return { output: results.slice(0, MAX_GREP_RESULTS).join("\n") + (results.length > MAX_GREP_RESULTS ? `\n(已截断至 ${MAX_GREP_RESULTS} 条)` : "") }
  },
}

// ---------- edit ----------

const editTool: ToolDef = {
  name: "edit",
  description:
    "对文件做文本替换(读取→替换→写回)。参数: path(必填), oldString(必填, 原文本片段), newString(必填, 替换文本)。最多替换前 count 处(默认 1)。用于局部修改; 大改动用 write 整体重写。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径" },
      oldString: { type: "string", description: "要替换的原文" },
      newString: { type: "string", description: "替换后的文本" },
      count: { type: "number", description: "最大替换次数, 默认为 1" },
    },
    required: ["path", "oldString", "newString"],
  },
  async execute(args, ctx) {
    const { readFileSync, writeFileSync, statSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const rawPath = String(args.path ?? "")
    const oldString = String(args.oldString ?? "")
    if (!rawPath) throw new Error("[edit] 缺少 path 参数")
    if (!oldString) throw new Error("[edit] 缺少 oldString 参数")
    const path = resolve(ctx.cwd, rawPath)
    const ok = await ctx.ask({ tool: "edit", summary: `${path}` })
    if (!ok) throw new Error("[edit] 用户拒绝了修改")
    // VBuild 模式: 在 overlay 上做编辑(读 overlay → 替换 → 写回 overlay)
    if (ctx.vfs) {
      const original = ctx.vfs.read(path)
      if (!original.includes(oldString)) throw new Error(`[edit] 在 ${path} 中未找到: ${oldString.slice(0, 80)}`)
      const count = Math.max(1, Number(args.count ?? 1))
      const replaced = count === 1 ? original.replace(oldString, String(args.newString ?? "")) : original.split(oldString).join(String(args.newString ?? ""))
      ctx.vfs.write(path, replaced)
      return { output: `[vbuild] 已暂存 ${path} 的替换 (待 RBuild 落盘)` }
    }
    const original = readFileSync(path, "utf8")
    if (!original.includes(oldString)) throw new Error(`[edit] 在 ${path} 中未找到: ${oldString.slice(0, 80)}`)
    const count = Math.max(1, Number(args.count ?? 1))
    const replaced = count === 1 ? original.replace(oldString, String(args.newString ?? "")) : original.split(oldString).join(String(args.newString ?? ""))
    writeFileSync(path, replaced, "utf8")
    return {
      output:
        count === 1
          ? `已在 ${path} 完成 1 处替换 (${statSync(path).size} 字节)`
          : `已在 ${path} 完成全部替换 (${statSync(path).size} 字节)`,
    }
  },
}

// ---------- influx 桥接(http.get / http.post / llm) ----------
// 复用 Influx 计划运行时的远端 HTTP 与 LLM 节点工具, 返回结构化结果转成文本回喂模型

const influxEmptyCtx = {
  results: {},
  errors: {},
  cwd: process.cwd(),
  ask: async () => true,
}

function influxTool(name: string, description: string, parameters: Record<string, unknown>): ToolDef {
  return {
    name,
    description,
    parameters,
    async execute(args) {
      const fn = getInfluxTool(name)
      const out = await fn(args, influxEmptyCtx)
      return { output: typeof out === "string" ? out : JSON.stringify(out) }
    },
  }
}

const httpGetTool = influxTool(
  "http_get",
  "GET 远端 API 并返回 JSON(自动解析)。参数: url(必填), headers(可选对象), timeoutMs(默认 30000)。返回 {status, headers, body}。适合抓网页/调用 API 验证。",
  {
    type: "object",
    properties: {
      url: { type: "string", description: "完整 URL, 必须带协议" },
      headers: { type: "object", description: "可选请求头, 如 Authorization" },
      timeoutMs: { type: "number", description: "超时毫秒, 默认 30000" },
    },
    required: ["url"],
  },
)

const httpPostTool = influxTool(
  "http_post",
  "POST 远端 API(JSON body)并返回 JSON(自动解析)。参数: url(必填), headers, body(对象, 自动序列化), timeoutMs。返回 {status, headers, body}。",
  {
    type: "object",
    properties: {
      url: { type: "string", description: "完整 URL, 必须带协议" },
      headers: { type: "object", description: "可选请求头" },
      body: { type: "object", description: "请求体, 自动 JSON 序列化" },
      timeoutMs: { type: "number", description: "超时毫秒, 默认 30000" },
    },
    required: ["url"],
  },
)

const llmTool = influxTool(
  "llm",
  "独立的 LLM 生成节点(OpenAI 兼容 /chat/completions)。参数: prompt(必填), system(可选), model, temperature(默认 0.2), url(默认 LLM_URL)。返回 {answer}。适合在任务中嵌入一次独立的模型调用。",
  {
    type: "object",
    properties: {
      prompt: { type: "string", description: "用户消息" },
      system: { type: "string", description: "系统提示" },
      model: { type: "string", description: "模型名, 默认 LLM_MODEL" },
      temperature: { type: "number", description: "采样温度, 默认 0.2" },
      url: { type: "string", description: "端点, 默认 LLM_URL" },
    },
    required: ["prompt"],
  },
)

export function builtinTools(): ToolDef[] {
  return [readTool, writeTool, bashTool, globTool, grepTool, editTool, httpGetTool, httpPostTool, llmTool]
}

/** 需要用户确认的工具: 写类与命令执行 */
export function requiresApproval(tool: string): boolean {
  return tool === "write" || tool === "edit" || tool === "bash"
}
