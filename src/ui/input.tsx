// 输入行 —— 自定义多行输入(替换 ink-text-input)
// 关键差异: ① Ctrl 组合键(ctrl+d 诊断 / ctrl+o 设置)不插入文本, 交由 App 处理;
//           ② Esc/Tab/↑↓ 不吞键, 交由 App(中断/焦点轮回/历史);
//           ③ 光标用反白块模拟, 层级克制(Apple 式)。
// 多行(基础重构): 输入可以很长(换行/超长文本), 但**显示区最高 maxRows 行**,
//   光标所在行始终可见(内部窗口跟随), 渲染行数严格 = 显示窗口行数 ——
//   这让 App 能把输入区高度精确计入视口, 整帧高度恒定, 不再触发 ink 的
//   每帧 clearTerminal(重影/卡顿的根因)。
// 编码安全: 用码点数组索引, CJK/emoji 不劈断。
// IME 安全: value/cursor 用 ref 同步镜像 —— 中文输入法一次组合会连发多个事件,
//           若读 React state(渲染后才更新)会拿到旧值, 光标位置会漂移/丢字。

import React, { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Box, Text, useInput, useCursor, useStdout } from "ink"
import type { ThemeTokens } from "./theme.ts"
import { displayWidth } from "./markdown.tsx"

// ---------- 终端光标绝对定位层 ----------
// 兜底: ink 每帧用"相对后缀"(nA/mG)定位光标, 依赖帧底=终端底+无滚动+eraseLines 语义;
// Warp/Ghostty/VS Code 等 GPU 渲染器在同步模式(?2026)下对"滚动+擦除+相对移动"的光标落点
// 与流式语义不一致(实测光标整体上偏 1 行或更多)。对策: 帧写出(esu 之后)再补一次
// `ESC[y+1;x+1H` 绝对定位 —— 只要帧顶=终端第 1 行(帧高≤终端高), 坐标与布局同源, 零漂移。
const bsu = "\u001B[?2026h"
const esu = "\u001B[?2026l"
let absY = -1
let absX = 0
const patched = new WeakSet<NodeJS.WriteStream>()

export function setImeCaretAbs(y: number, x: number): void {
  absY = y
  absX = x
}

export function clearImeCaretAbs(): void {
  absY = -1
}

function patchStdout(stdout: NodeJS.WriteStream): void {
  if (patched.has(stdout)) return
  patched.add(stdout)
  const orig = stdout.write.bind(stdout)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stdout.write = ((chunk: any, ...rest: any[]) => {
    const s = typeof chunk === "string" ? chunk : String(chunk)
    const r = orig(chunk, ...rest)
    if (s.endsWith(esu) && absY >= 0) {
      orig(`\u001B[${absY + 1};${absX + 1}H`)
    }
    return r
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
}

// ---------- 纯函数: 输入可视行拆分(与渲染同一口径, 可单测) ----------

export interface VisualLine {
  /** 码点区间 [start, end), end 不含换行符 */
  start: number
  end: number
}

/** 把输入文本按显示宽折成可视行(\n 强制换行; 单个超宽字符独立成行, 不劈双宽) */
export function visualLinesOf(value: string, wrap: number): VisualLine[] {
  const w = Math.max(1, wrap)
  const chars = [...value]
  const lines: VisualLine[] = []
  let start = 0
  let col = 0
  let i = 0
  for (;;) {
    if (i === chars.length) {
      lines.push({ start, end: i })
      break
    }
    const ch = chars[i]!
    if (ch === "\n") {
      lines.push({ start, end: i })
      start = i + 1
      col = 0
      i++
      continue
    }
    const wdt = displayWidth(ch)
    if (col > 0 && col + wdt > w) {
      // 折行: 从当前字符起新行(该字符不劈断)
      lines.push({ start, end: i })
      start = i
      col = 0
      continue
    }
    col += wdt
    i++
  }
  return lines
}

/** 输入行信息: 总行数 / 光标所在行(0 基) / 光标在该行内的显示宽 */
export function inputLineInfo(value: string, wrap: number, cursor: number = [...value].length): { rows: number; caretRow: number; caretCol: number } {
  const lines = visualLinesOf(value, wrap)
  const rows = Math.max(1, lines.length)
  let caretRow = Math.max(0, lines.length - 1)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (cursor >= l.start && cursor <= l.end) {
      caretRow = i
      break
    }
  }
  const cs = cursor <= 0 ? 0 : Math.min(cursor, [...value].length)
  const prefix = [...value].slice(lines[caretRow]!.start, cs)
  const caretCol = prefix.reduce((a, c) => a + (c === "\n" ? 0 : displayWidth(c)), 0)
  return { rows, caretRow, caretCol }
}

/** 渲染窗口切片: [winTop, winTop+rowCount) 行, 每行为独立文本(不跨行); 光标字符位置以 caretAt 标记 */
export function sliceInputText(
  value: string,
  wrap: number,
  winTop: number,
  rowCount: number,
  cursor: number,
): { lines: Array<{ text: string; caretAt: number | null }>; caretVisible: boolean } {
  const chars = [...value]
  const all = visualLinesOf(value, wrap)
  const win = all.slice(winTop, winTop + rowCount)
  let caretVisible = false
  const out = win.map((l) => {
    const text = chars.slice(l.start, l.end).join("")
    let caretAt: number | null = null
    if (cursor >= l.start && cursor <= l.end) {
      caretAt = Math.min(cursor - l.start, text.length)
      caretVisible = true
    }
    return { text, caretAt }
  })
  return { lines: out, caretVisible }
}

// ---------- 输入组件 ----------

export function Input({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  t,
  realCaret,
  wrap,
  maxRows = 3,
  inputTop,
  absSafe,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit?: (v: string) => void
  placeholder?: string
  focus?: boolean
  t: ThemeTokens
  /** 真实终端光标(供中文输入法组合条锚定): base=首列(1 基), 二者联合给出绝对坐标 */
  realCaret?: { base: number }
  /** 输入内容的换行宽(与 App 的消息区宽度同源) */
  wrap?: number
  /** 显示区最高行数(超出内部滚动跟随光标) */
  maxRows?: number
  /** 输入内容首行的绝对行号(0 基, 相对终端顶) —— App 与视口同源构造, IME 光标 y 零漂移 */
  inputTop?: number
  /** 帧高≤终端高(无滚动溢出)时, 用绝对定位兜底终端的相对光标偏移(见文件头注释) */
  absSafe?: boolean
}): ReactNode {
  // ---- 同步镜像: 事件处理器永远读到最新值, 不依赖渲染节奏 ----
  const valueRef = useRef(value)
  const cursorRef = useRef([...value].length)
  const [, force] = useState(0)
  valueRef.current = value

  const emit = (v: string): void => {
    valueRef.current = v
    onChange(v)
  }

  const setCursor = (n: number): void => {
    cursorRef.current = n
    force((x) => x + 1)
  }

  // 外部重置(提交清空/命令)后夹取光标
  useEffect(() => {
    cursorRef.current = Math.min(cursorRef.current, [...value].length)
    force((x) => x + 1)
  }, [value])

  useInput((input, key) => {
    if (!focus) return
    if (key.ctrl || key.escape || key.tab || key.upArrow || key.downArrow) {
      // 不插入文本, 交由 App 层处理(Ctrl+o/d / 中断 / 焦点轮回 / 历史)
      return
    }
    if (key.return) {
      if (onSubmit) {
        onSubmit(valueRef.current)
        return true
      }
      return // 无 onSubmit 时交给上层处理(设置面板 Enter=保存)
    }
    const cur = [...valueRef.current].length
    if (key.leftArrow) {
      setCursor(Math.max(0, cursorRef.current - 1))
      return true
    }
    if (key.rightArrow) {
      setCursor(Math.min(cur, cursorRef.current + 1))
      return true
    }
    if (key.home) {
      setCursor(0)
      return true
    }
    if (key.end) {
      setCursor(cur)
      return true
    }
    if (key.backspace || key.delete) {
      const all = [...valueRef.current]
      const pos = cursorRef.current
      if (key.delete) {
        if (pos < all.length) {
          all.splice(pos, 1)
          emit(all.join(""))
        }
      } else if (pos > 0) {
        all.splice(pos - 1, 1)
        emit(all.join(""))
        setCursor(Math.max(0, pos - 1))
      }
      return true
    }
    if (input) {
      const all = [...valueRef.current]
      const pos = cursorRef.current
      all.splice(pos, 0, ...input)
      emit(all.join(""))
      setCursor(pos + [...input].length)
      return true
    }
  })

  const cursor = cursorRef.current
  const wrapW = Math.max(1, wrap ?? 80)
  // 占位符与输入同口径: 空输入时行数 = 占位符换行行数(与 App 的 inputRows 一致),
  // 否则输入区盒高/光标行与 App 侧漂移 → 光标错位
  const { rows, caretRow, caretCol } = inputLineInfo(value || placeholder || "", wrapW, cursor)
  const showRows = Math.min(Math.max(1, rows), Math.max(1, maxRows))
  // 窗口跟随: 光标行在窗口内且尽量向底部流动(输入长文本时窗口平滑下移)
  const winTop = rows <= showRows ? 0 : Math.min(Math.max(0, caretRow - showRows + 1), rows - showRows)
  const { lines, caretVisible } = sliceInputText(value, wrapW, winTop, showRows, cursor)
  const caretInWinRow = caretVisible ? caretRow - winTop : -1
  const curChar = caretVisible ? [...value][cursor] ?? "" : ""

  // 真实光标: 钉在输入区的光标显示行(窗口内) —— 中文输入法组合条/候选窗锚定
  const { stdout } = useStdout()
  const { setCursorPosition } = useCursor()
  const cols = stdout.columns ?? 80
  const rowsTerm = stdout.rows ?? 24
  // 绝对层无条件武装(不设 absOn 门槛): 模块变量的生命周期必须与"帧写出"对齐,
  // 若夹在渲染时与 esu 落盘之间被中途提交清掉(absY=-1), 本帧的绝对定位会静默丢失
  const imeTargetX = Math.max(0, realCaret ? realCaret.base - 1 + caretCol : 0)
  const imeTargetY = Math.max(0, (inputTop ?? 0) + Math.max(0, caretInWinRow))
  setCursorPosition(
    focus && realCaret && caretInWinRow >= 0
      ? { x: Math.min(Math.max(0, cols - 1), imeTargetX), y: Math.min(rowsTerm - 1, imeTargetY) }
      : undefined
  )
  setImeCaretAbs(imeTargetY, imeTargetX)
  useEffect(() => {
    patchStdout(stdout)
    // esu 落盘前的最后一刻重武装 —— 与帧写出同属于提交阶段, 消除渲染期武装被覆盖的竞态
    setImeCaretAbs(imeTargetY, imeTargetX)
    return () => clearImeCaretAbs()
  }, [stdout, imeTargetY, imeTargetX])

  return (
    <Box height={showRows} flexGrow={1} flexDirection="column">
        {value.length === 0 && placeholder ? (
          <Text dimColor wrap="wrap">
            {placeholder}
          </Text>
        ) : (
          lines.map((l, i) => (
            <Text key={i}>
              {l.caretAt === null ? (
                l.text
              ) : (
                <>
                  {l.text.slice(0, l.caretAt)}
                  {focus && !realCaret ? <Text inverse>{curChar || " "}</Text> : curChar}
                  {l.text.slice((l.caretAt ?? 0) + 1)}
                </>
              )}
            </Text>
          ))
        )}
    </Box>
  )
}