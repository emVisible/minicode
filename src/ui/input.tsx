// 输入行 —— 自定义 TextInput(替换 ink-text-input)
// 关键差异: ① Ctrl 组合键(ctrl+d 诊断 / ctrl+o 设置)不插入文本, 交由 App 处理;
//           ② Esc/Tab 不吞键, 交由 App(中断/焦点轮回);
//           ③ 光标用反白块模拟, 层级克制(Apple 式)。
// 编码安全: 用码点数组索引, CJK/emoji 不劈断。

import React, { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { Box, Text, useInput } from "ink"
import type { ThemeTokens } from "./theme.ts"

export function Input({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  t,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit?: (v: string) => void
  placeholder?: string
  focus?: boolean
  t: ThemeTokens
}): ReactNode {
  const chars = [...value]
  const [cursor, setCursor] = useState(chars.length)

  useEffect(() => {
    setCursor((c) => Math.min(c, [...value].length))
  }, [value])

  useInput((input, key) => {
    if (!focus) return
    if (key.ctrl || key.escape || key.tab || key.upArrow || key.downArrow) {
      // 不插入文本, 交由 App 层处理(Ctrl+o/d / 中断 / 焦点轮回)
      return
    }
    if (key.return) {
      if (onSubmit) {
        onSubmit(value)
        return true
      }
      return // 无 onSubmit 时交给上层处理(设置面板 Enter=保存)
    }
    const cur = [...value].length
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1))
      return true
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(cur, c + 1))
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
      const all = [...value]
      const pos = cursor
      if (key.delete) {
        if (pos < all.length) {
          all.splice(pos, 1)
          onChange(all.join(""))
        }
      } else if (pos > 0) {
        all.splice(pos - 1, 1)
        onChange(all.join(""))
        setCursor((c) => Math.max(0, c - 1))
      }
      return true
    }
    if (input) {
      const all = [...value]
      all.splice(cursor, 0, ...input)
      onChange(all.join(""))
      setCursor(cursor + [...input].length)
      return true
    }
  })

  const shown = chars.slice(0, cursor).join("")
  const cur = chars[cursor]
  const rest = chars.slice(cursor + 1).join("")

  return (
    <Box flexGrow={1} flexDirection="column">
      {value.length === 0 && placeholder ? (
        <Text dimColor wrap="wrap">
          {placeholder}
        </Text>
      ) : (
        <Text wrap="wrap">
          {shown}
          {focus ? <Text inverse>{cur || " "}</Text> : cur}
          {rest}
        </Text>
      )}
    </Box>
  )
}
