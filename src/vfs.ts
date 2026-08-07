// 虚拟文件系统(VFS)—— VBuild/RBuild 两段式构建的核心
//
// VBuild(Virtual Build): 所有写操作进入内存 overlay, 不触碰磁盘。
//   多个写可全并行(内存无竞争), 且可随时预览 diff、回滚。
// RBuild(Real Build): VBuild 确认后, 把 overlay 的改动批量并行刷到磁盘。
//
// 设计类比 git index: write/edit 是 stage, commit() 是 checkout。
// 读语义: 读优先 overlay(虚拟层), 无则回退磁盘 —— 保证虚拟构建期间
// 后续工具读到的是"构建后的世界", 而不是磁盘旧状态。

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"

export interface VfsChange {
  /** 相对或绝对路径(与写入时一致) */
  path: string
  kind: "create" | "modify" | "delete"
  /** 新内容(create/modify); delete 时为空 */
  content: string
  /** 旧内容(create 时为空) */
  old: string
  bytes: number
}

export class VFS {
  /** overlay: 相对 cwd 的规范化路径 → 内容 */
  private files = new Map<string, { content: string; dirty: boolean }>()
  /** 记录磁盘原文, 用于 diff */
  private originals = new Map<string, string>()
  private deleted = new Set<string>()
  /** 已 flush 到磁盘的 key(rollback 时需恢复原文) */
  private flushed = new Set<string>()
  private _cwd: string

  constructor(cwd: string) {
    this._cwd = cwd
  }

  /** 归一化: 相对 cwd → 绝对路径 */
  abs(p: string): string {
    return resolve(this._cwd, p)
  }

  key(p: string): string {
    return this.abs(p)
  }

  /** 写入 overlay(虚拟层)。不落盘 —— VBuild 阶段的核心 */
  write(p: string, content: string): void {
    const k = this.key(p)
    if (!this.originals.has(k)) {
      try {
        this.originals.set(k, readFileSync(k, "utf8"))
      } catch {
        this.originals.set(k, "") // 磁盘不存在 → 视为 create
      }
    }
    this.deleted.delete(k)
    this.files.set(k, { content, dirty: true })
  }

  /** 删除标记(VBuild 阶段不真删) */
  remove(p: string): void {
    const k = this.key(p)
    if (!this.originals.has(k)) {
      try {
        this.originals.set(k, readFileSync(k, "utf8"))
      } catch {
        this.originals.set(k, "") // 磁盘不存在 → 视为空原文
      }
    }
    this.files.delete(k)
    this.deleted.add(k)
  }

  /** 读: overlay 优先, 否则磁盘。虚拟构建期间读到的是"构建后"状态 */
  read(p: string): string {
    const k = this.key(p)
    const v = this.files.get(k)
    if (v) return v.content
    if (this.deleted.has(k)) throw new Error(`[vfs] 文件已被虚拟删除: ${p}`)
    return readFileSync(k, "utf8")
  }

  has(p: string): boolean {
    const k = this.key(p)
    if (this.files.has(k) || this.deleted.has(k)) return true
    return existsSync(k)
  }

  /** 与磁盘对比, 生成改动清单(diff 预览用) */
  diff(): VfsChange[] {
    const out: VfsChange[] = []
    for (const [k, v] of this.files) {
      const old = this.originals.get(k) ?? ""
      out.push({
        path: k,
        kind: old === "" && !existsSync(k) ? "create" : "modify",
        content: v.content,
        old,
        bytes: Buffer.byteLength(v.content),
      })
    }
    for (const k of this.deleted) {
      const old = this.originals.get(k) ?? ""
      out.push({ path: k, kind: "delete", content: "", old, bytes: 0 })
    }
    return out
  }

  /** 统计(供 UI 摘要) */
  summary(): { create: number; modify: number; del: number; bytes: number } {
    const d = this.diff()
    return {
      create: d.filter((c) => c.kind === "create").length,
      modify: d.filter((c) => c.kind === "modify").length,
      del: d.filter((c) => c.kind === "delete").length,
      bytes: d.reduce((s, c) => s + c.bytes, 0),
    }
  }

  /**
   * flushToDisk: 把已暂存的创建/修改文件真实刷到磁盘。
   * 用途: shell/bash 等磁盘观察型工具无法读 overlay —— 执行前把暂存内容落盘,
   * 让 `bash fix.sh` 这类依赖前序 write-file 的命令能看到"构建中的世界"。
   * 已 flush 的文件仍被 VFS 跟踪: commit 幂等重写, rollback 会恢复原文。
   * 删除标记不在此阶段生效(不冒险瞬删真实文件), 留到 commit。
   */
  flushToDisk(): void {
    for (const [k, v] of this.files) {
      if (this.flushed.has(k)) continue
      try {
        mkdirSync(dirname(k), { recursive: true })
        writeFileSync(k, v.content, "utf8")
        this.flushed.add(k)
      } catch {
        // 无权限等 → 忽略, 保持 overlay 语义
      }
    }
  }

  /**
   * RBuild: 把 overlay 全部改动批量并行刷到磁盘。
   * 并行写不同文件(独立 IO), 完成后清空 overlay —— 一次构建两段完成。
   * 落盘前为 /undo 快照每个文件的磁盘原文与目标内容。
   */
  async commit(): Promise<VfsChange[]> {
    const changes = this.diff()
    const { captureMany } = await import("./undo.ts")
    captureMany(changes.map((c) => ({ path: c.path, before: c.kind === "create" ? null : c.old, after: c.kind === "delete" ? null : c.content })))
    await Promise.all(
      changes.map(async (c) => {
        if (c.kind === "delete") {
          const { rm } = await import("node:fs/promises")
          await rm(c.path, { force: true })
        } else {
          mkdirSync(dirname(c.path), { recursive: true })
          writeFileSync(c.path, c.content, "utf8")
        }
      }),
    )
    this.files.clear()
    this.deleted.clear()
    this.originals.clear()
    this.flushed.clear()
    return changes
  }

  /** 丢弃 overlay(回滚 VBuild, 不碰磁盘) */
  rollback(): void {
    // 已 flush 到磁盘的文件先恢复原文(防止"构建中的世界"残留在磁盘)
    for (const k of this.flushed) {
      const original = this.originals.get(k)
      try {
        if (original !== undefined && original !== "") {
          mkdirSync(dirname(k), { recursive: true })
          writeFileSync(k, original, "utf8")
        } else {
          rmSync(k, { force: true })
        }
      } catch {
        // 恢复失败忽略
      }
    }
    this.files.clear()
    this.deleted.clear()
    this.originals.clear()
    this.flushed.clear()
  }

  get cwd(): string {
    return this._cwd
  }

  get size(): number {
    return this.files.size + this.deleted.size
  }

  hasChanges(): boolean {
    return this.size > 0
  }
}
