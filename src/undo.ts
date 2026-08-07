// /undo /redo —— 文件级快照回滚(对齐 opencode 的撤销能力)
//
// 机制: 每次构建/对话执行开始时 newFrame() 开启一个新快照帧;
// 磁盘写发生前(工具层)capture(path, before, after) 记录原文与目标内容;
// /undo: 把当前帧的所有改动恢复原样(新建→删除, 删除→还原, 修改→写回原文);
// /redo: 重放撤销掉的改动。栈式: 多次 /undo 逐帧回退, /redo 逐帧前滚。
// 只作用于真实磁盘写; VBuild 虚拟层(未落盘)由 VFS rollback 处理, 互不冲突。

import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { log } from "./log.ts"

interface FileChange {
  path: string
  before: string | null // null = 原本不存在(undo 时删除)
  after: string | null // null = 本次删除(undo 时还原 before)
}

/** 当前帧的改动记录 */
const frames: FileChange[][] = []
/** 已撤销的帧(redo 队列) */
const redoStack: FileChange[][] = []

export function undoStats(): { frames: number; redo: number } {
  return { frames: frames.length, redo: redoStack.length }
}

/** 新一轮执行开始: 开启新快照帧 */
export function newFrame(): void {
  if (frames.length === 0 || frames[frames.length - 1]!.length > 0) {
    frames.push([])
  }
  redoStack.length = 0
}

/** 磁盘写发生前调用: 记录 before(磁盘原文)与 after(将要写入的内容) */
export function capture(path: string, before: string | null, after: string | null): void {
  const frame = frames[frames.length - 1]
  if (!frame) return
  const existing = frame.find((c) => c.path === path)
  if (existing) {
    // 同一帧内多次写同一文件: 以最早 before 与最新 after 为准
    existing.after = after
    return
  }
  frame.push({ path, before, after })
}

/** 批量捕获(RBuild 落盘前用): changes 含 before(磁盘原文)/after(目标内容) */
export function captureMany(changes: Array<{ path: string; before: string | null; after: string | null }>): void {
  for (const c of changes) capture(c.path, c.before, c.after)
}

/** 撤销当前帧: 恢复全部改动 */
export function undo(): { restored: string[]; msg: string } {
  const frame = frames.pop()
  redoStack.push(frame ?? [])
  frames.push([])
  if (!frame || frame.length === 0) return { restored: [], msg: "没有可撤销的改动" }
  const restored: string[] = []
  for (const c of frame) {
    try {
      if (c.before === null) {
        rmSync(c.path, { force: true })
      } else {
        mkdirSync(dirname(c.path), { recursive: true })
        writeFileSync(c.path, c.before, "utf8")
      }
      restored.push(c.path)
    } catch (e) {
      log.error("undo", "恢复失败", { path: c.path, error: e instanceof Error ? e.message : String(e) })
    }
  }
  log.info("undo", "已撤销", { files: restored.length })
  return { restored, msg: `已撤销 ${restored.length} 个文件的改动` }
}

/** 重做: 重放最近一次撤销的帧 */
export function redo(): { restored: string[]; msg: string } {
  const frame = redoStack.pop()
  if (!frame) {
    frames.push([])
    return { restored: [], msg: "没有可重做的改动" }
  }
  frames.pop() // 移除撤销后留下的空帧
  frames.push(frame)
  if (frame.length === 0) return { restored: [], msg: "没有可重做的改动" }
  const restored: string[] = []
  for (const c of frame) {
    try {
      if (c.after === null) {
        rmSync(c.path, { force: true })
      } else {
        mkdirSync(dirname(c.path), { recursive: true })
        writeFileSync(c.path, c.after, "utf8")
      }
      restored.push(c.path)
    } catch (e) {
      log.error("redo", "重做失败", { path: c.path, error: e instanceof Error ? e.message : String(e) })
    }
  }
  log.info("redo", "已重做", { files: restored.length })
  return { restored, msg: `已重做 ${restored.length} 个文件的改动` }
}
