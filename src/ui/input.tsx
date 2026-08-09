// 输入行 —— 自定义 TextInput(替换 ink-text-input)
// 关键差异: ① Ctrl 组合键(ctrl+d 诊断 / ctrl+o 设置)不插入文本, 交由 App 处理;
//           ② Esc/Tab 不吞键, 交由 App(中断/焦点轮回);
//           ③ 光标用反白块模拟, 层级克制(Apple 式)。
// 编码安全: 用码点数组索引, CJK/emoji 不劈断。
// IME 安全: value/cursor 用 ref 同步镜像 —— 中文输入法一次组合会连发多个事件,
//           若读 React state(渲染后才更新)会拿到旧值, 光标位置会漂移/丢字。

import React, { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Box, Text, useInput, useCursor, useStdout } from "ink"
import type { ThemeTokens } from "./theme.ts"
import { displayWidth } from "./markdown.tsx"

export function Input({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  t,
  realCaret,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit?: (v: string) => void
  placeholder?: string
  focus?: boolean
  t: ThemeTokens
  /** 真实终端光标(供中文输入法组合条锚定): base=首列(1 基), wrap=换行宽 */
  realCaret?: { base: number; wrap: number }
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
      // 不插入文本, 交由 App 层处理(Ctrl+o/d / 中断 / 焦点轮回)
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

  const chars = [...value]
  const cursor = cursorRef.current
  const shown = chars.slice(0, cursor).join("")
  const cur = chars[cursor]
  const rest = chars.slice(cursor + 1).join("")

  // 真实光标: 固定在输入区首行(与 Input 同帧的最底行), 列随光标位置——
  // 否则中文输入法的组合条/候选窗会漂到终端角落或别处。
  // 坐标系: Ink 的 (x, y) 是 0 基且光标落在最终帧的最底行, 传 1 基会整体错位一行/一列
  const { stdout } = useStdout()
  const { setCursorPosition } = useCursor()
  const cols = stdout.columns ?? 80
  const rows = stdout.rows ?? 24
  const wrap = realCaret?.wrap ?? Math.max(1, cols - 4 - (realCaret?.base ?? 0))
  const lineCol = displayWidth(shown) % Math.max(1, wrap)
  setCursorPosition(
    focus && realCaret
      ? {
          x: Math.min(Math.max(0, cols), Math.max(0, realCaret.base - 1 + lineCol)),
          y: Math.max(0, rows - 3 - Math.floor(displayWidth(shown) / Math.max(1, wrap))),
        }
      : undefined
  )

  return (
    <Box flexGrow={1} flexDirection="column">
      {value.length === 0 && placeholder ? (
        <Text dimColor wrap="wrap">
          {placeholder}
        </Text>
      ) : (
        <Text wrap="wrap">
          {shown}
          {focus && !realCaret ? <Text inverse>{cur || " "}</Text> : cur}
          {rest}
        </Text>
      )}
    </Box>
  )
}
