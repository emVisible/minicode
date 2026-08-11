// 自研 SGR 鼠标协议(零依赖): 把终端鼠标序列(\x1b[<b;r;cM/m)从 stdin 中剥离并翻译成事件。
//
// 关键设计: ink 7 的 parseKeypress 不认识 SGR 序列, 会把它当普通文本送进 useInput
// → 鼠标点击会往输入框里打 "[<0;12;34M"。所以不能只挂一个 data 监听(ink 也在读 stdin),
// 正确做法是给 render() 传入一个**代理 stdin**: 我们独占读取原始 stdin, 剥离鼠标序列,
// 其余字节原样转发给 ink —— 鼠标字节在 ink 解析器之前就被过滤掉了。

import { Readable } from "node:stream"

export interface MouseEventData {
  /** 1-based 终端行 */
  row: number
  /** 1-based 终端列 */
  col: number
  /** 0=左键, 1=中键, 2=右键; 64=滚轮上, 65=滚轮下 */
  button: number
  /** 按下事件(M); false 表示释放/点击完成(m, 部分终端只发释放) */
  release: boolean
  /** 按住时是否带修饰键(shift/alt/ctrl, 编码在 b 的高位) */
  ctrl: boolean
  shift: boolean
  alt: boolean
}

/** App 订阅鼠标事件的通道(cli 创建代理时注入, App 用 useEffect 订阅) */
export interface MouseBus {
  on(cb: (e: MouseEventData) => void): () => void
}

/** 解析一条 SGR/X10 鼠标序列; 返回 null 表示不是鼠标序列 */
export function parseMouseSeq(seq: string): MouseEventData | null {
  // SGR: \x1b[<b;r;cM (按下) / \x1b[<b;r;cm (释放)
  const sgr = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)
  if (sgr) {
    const raw = Number(sgr[1])
    return {
      row: Number(sgr[2]),
      col: Number(sgr[3]),
      button: raw >= 64 ? (raw >= 65 ? 65 : 64) : raw & 0b11,
      release: sgr[4] === "m",
      ctrl: (raw >> 4 & 1) === 1,
      shift: (raw >> 2 & 1) === 1,
      alt: (raw >> 3 & 1) === 1,
    }
  }
  // X10 兜底: \x1b[M <btn+32><row+32><col+32>(仅部分老终端)
  const x10 = seq.match(/^\x1b\[M(.{3})$/)
  if (x10) {
    const [b, r, c] = x10[1]!.split("").map((ch) => ch.charCodeAt(0) - 32)
    const raw = b ?? 0
    return {
      row: r ?? 0,
      col: c ?? 0,
      button: raw >= 64 ? (raw >= 65 ? 65 : 64) : raw & 0b11,
      release: (raw & 0b11) === 3,
      ctrl: (raw >> 4 & 1) === 1,
      shift: (raw >> 2 & 1) === 1,
      alt: (raw >> 3 & 1) === 1,
    }
  }
  return null
}

/**
 * 鼠标过滤代理 stdin: 实现 Readable 接口供 ink render({stdin}) 使用。
 * 读取原始 stdin → 从中剥离 SGR/X10 鼠标序列(onMouse 回调) → 其余字节 push 给 ink。
 * 返回 { stdin, bus }: stdin 传给 render, bus 供 App 订阅点击/滚轮。
 */
export function createMouseFilterStdin(
  original: NodeJS.ReadStream,
  onMouse: (e: MouseEventData) => void,
): { stdin: Readable; bus: MouseBus } {
  const listeners = new Set<(e: MouseEventData) => void>()
  const bus: MouseBus = {
    on(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  // 按下事件的最近位置: 用于对"按下+释放"事件对去重(释放只当作兜底,
  // 某些终端只发释放 m 而不发按下 M, 此时单独到达的释放视为一次点击)
  let lastPress: { row: number; col: number; ts: number } | null = null
  const deliver = (e: MouseEventData): void => {
    if (!e.release) {
      if (e.button <= 2) lastPress = { row: e.row, col: e.col, ts: Date.now() }
      onMouse(e)
      for (const cb of listeners) cb(e)
      return
    }
    const p = lastPress
    if (p && p.row === e.row && p.col === e.col && Date.now() - p.ts < 500) {
      return // 与按下配对: 按下已触发, 释放丢弃
    }
    onMouse(e)
    for (const cb of listeners) cb(e)
  }
  const proxy = new Readable({
    read() {
      // 底层的 readable/data 已由下面的监听驱动; 这里只需确保处于流动状态
      original.resume()
    },
  })
  // 把原始 stdin 的 TTY 属性透传给代理(ink 检查 stdin.isTTY)
  ;(proxy as any).isTTY = (original as any).isTTY === true

  let buf = ""
  const MOUSE_PREFIX = "\x1b[<"
  const X10_PREFIX = "\x1b[M"

  original.on("data", (chunk: Buffer) => {
    let text = chunk.toString("utf8")
    // 解析可能跨 chunk 拆分: 先拼接进缓冲, 再逐条剥离
    buf += text
    let consumed = 0
    let i = 0
    while (i < buf.length) {
      const sgrAt = buf.indexOf(MOUSE_PREFIX, i)
      const x10At = buf.indexOf(X10_PREFIX, i)
      // 找下一个鼠标序列起点
      let next: number
      if (sgrAt === -1 && x10At === -1) {
        next = -1
      } else if (sgrAt === -1) next = x10At
      else if (x10At === -1) next = sgrAt
      else next = Math.min(sgrAt, x10At)
      if (next === -1) {
        // 缓冲里已无鼠标序列: 剩余文本全部转发给 ink
        if (i < buf.length) proxy.push(buf.slice(i))
        i = buf.length
        break
      }
      // 序列之前的普通文本转发给 ink
      if (next > i) {
        const plain = buf.slice(i, next)
        proxy.push(plain)
        consumed = Math.max(consumed, next)
      }
      // 尝试解析当前序列(可能不完整 → 等待更多数据)
      const rest = buf.slice(next)
      const isMouseLike = rest.startsWith(MOUSE_PREFIX) || rest.startsWith(X10_PREFIX)
      if (!isMouseLike) {
        // 非鼠标转义序列(方向键/功能键/颜色等): 直接转发给 ink, 不逐字节解析
        const escEnd = findEscapeEnd(rest)
        if (escEnd === -1) {
          // 序列可能跨 chunk 截断(如单独收到 \x1b[A 的 \x1b[A 尾部)
          proxy.push(rest)
          i = buf.length
          break
        }
        proxy.push(rest.slice(0, escEnd))
        i = next + escEnd
        continue
      }
      const seqEnd = findSeqEnd(rest)
      if (seqEnd === -1) {
        i = next
        break
      }
      const seq = rest.slice(0, seqEnd)
      const mouse = parseMouseSeq(seq)
      if (mouse) {
        deliver(mouse)
      } else {
        // 鼠标格式但不匹配(如释放事件): 丢弃, 不外泄给 ink
      }
      i = next + seqEnd
      consumed = Math.max(consumed, i)
    }
    // 丢弃已消费部分; 保留尾部未完成的序列(等待下一 chunk)
    buf = buf.slice(i)
    void consumed
  })

  // 透传 raw mode / ref / unref / setEncoding 管理(ink 在挂载/卸载时调用这些方法)
  ;(proxy as any).setRawMode = (flag: boolean): boolean => {
    if (typeof (original as any).setRawMode === "function") (original as any).setRawMode(flag)
    return true
  }
  ;(proxy as any).setEncoding = (enc: string): void => {
    ;(original as any).setEncoding?.(enc)
  }
  ;(proxy as any).ref = (): void => {
    ;(original as any).ref?.()
  }
  ;(proxy as any).unref = (): void => {
    ;(original as any).unref?.()
  }
  return { stdin: proxy, bus }
}

/** 找非鼠标转义序列的结尾: ESC 开头, 到第一个控制结束符(字母/~/^$ 等)为止 */
function findEscapeEnd(rest: string): number {
  for (let j = 1; j < rest.length; j++) {
    const ch = rest[j]!
    const code = ch.charCodeAt(0)
    // CSI 参数位(0x30-0x3f)与中间位(0x20-0x2f)继续; 0x40-0x7e 为结束
    if (code >= 0x30 && code <= 0x7e) return j + 1
    if (code < 0x20) return -1 // 控制字符结尾(不常见)
  }
  return -1
}

/** 找鼠标序列结尾(相对偏移): SGR 以 M/m 结尾且中间只允许数字/分号; 不完整返回 -1 */
function findSeqEnd(rest: string): number {
  if (rest.startsWith("\x1b[<")) {
    for (let j = 4; j < rest.length; j++) {
      const ch = rest[j]!
      if (ch >= "0" && ch <= "9") continue
      if (ch === ";") continue
      if (ch === "M" || ch === "m") return j + 1
      return -1 // 非法字符 → 不是鼠标序列
    }
    return -1 // 截断, 等更多数据
  }
  if (rest.startsWith("\x1b[M")) {
    return rest.length >= 6 ? 6 : -1
  }
  return -1
}
