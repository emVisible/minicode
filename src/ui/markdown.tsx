// 极简 Markdown 渲染器 —— 面向终端对话流
// 支持: 标题(#~####) / 无序列表(- *)、有序列表(1.) / 代码块(```) / 引用(>)
//       行内: **粗体** 与 `行内代码`
// 不引入依赖, 用 Ink Text 嵌套实现行内着色

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"

/** 行内解析: **bold** 与 `code` 拆成嵌套 Text 片段 */
function inlineSegments(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith("**")) {
      out.push(
        <Text key={`${keyBase}b${k++}`} bold>
          {tok.slice(2, -2)}
        </Text>,
      )
    } else {
      out.push(
        <Text key={`${keyBase}c${k++}`} color="cyan">
          {tok.slice(1, -1)}
        </Text>,
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * 把一段文本渲染为 Markdown 行(逐行 ReactNode)。
 * 代码块跨行维护状态; 每行独立 key 便于流式追加时最小化 diff。
 */
export function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split("\n")
  const out: ReactNode[] = []
  let inCode = false
  let codeBuf: string[] = []
  let codeStart = 0

  const flushCode = (endKey: string) => {
    if (!codeBuf.length) return
    out.push(
      <Box key={endKey} flexDirection="column" paddingLeft={2} borderStyle="round" borderColor="gray">
        {codeBuf.map((l, i) => (
          <Text key={`${endKey}-${i}`} color="yellow">
            {l || " "}
          </Text>
        ))}
      </Box>,
    )
    codeBuf = []
  }

  lines.forEach((line, i) => {
    const key = `l${i}`
    const t = line.trim()
    if (t.startsWith("```")) {
      if (inCode) {
        inCode = false
        flushCode(`code-${codeStart}`)
      } else {
        inCode = true
        codeStart = i
      }
      return
    }
    if (inCode) {
      codeBuf.push(line)
      return
    }
    if (/^#{1,4}\s/.test(line)) {
      const level = (line.match(/^#+/) ?? [""])[0]!.length
      const title = line.replace(/^#+\s*/, "")
      out.push(
        <Text key={key} bold color={level <= 2 ? "cyan" : "white"}>
          {inlineSegments(title, key)}
        </Text>,
      )
    } else if (/^[-*]\s/.test(line)) {
      out.push(
        <Text key={key}>
          <Text color="gray">• </Text>
          {inlineSegments(line.replace(/^[-*]\s/, ""), key)}
        </Text>,
      )
    } else if (/^\d+\.\s/.test(line)) {
      const num = (line.match(/^\d+\./) ?? [""])[0]!
      out.push(
        <Text key={key}>
          <Text color="gray">{num} </Text>
          {inlineSegments(line.replace(/^\d+\.\s/, ""), key)}
        </Text>,
      )
    } else if (t.startsWith(">")) {
      out.push(
        <Text key={key} color="gray">
          │ {inlineSegments(line.replace(/^>\s?/, ""), key)}
        </Text>,
      )
    } else if (t === "") {
      out.push(<Text key={key}> </Text>)
    } else {
      out.push(<Text key={key}>{inlineSegments(line, key)}</Text>)
    }
  })
  flushCode(`code-end-${lines.length}`)
  return out
}

/** 代码块内的行(等宽视觉, 无行内解析) */
export function renderCodeLine(line: string, key: string): ReactNode {
  return (
    <Text key={key} color="yellow">
      {line || " "}
    </Text>
  )
}
