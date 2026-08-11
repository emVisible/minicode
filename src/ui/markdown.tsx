// 终端 Markdown 渲染器 —— Apple 式排印: 层级用字重与亮度, 颜色克制
// 支持: 标题 / 无序·有序·任务·嵌套列表 / 表格(CJK 宽度对齐) / 引用 rail /
//       代码块(左 rail + 微底色 + 迷你高亮) / 分隔线(细发线) /
//       行内 bold / italic(dim 降级) / strikethrough / code / link
// 不引入依赖, 手写轻量 tokenizer。

import React from "react"
import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { ThemeTokens } from "./theme.ts"

// ---------- 字符宽度(CJK 全角感知) ----------

function charDisplayWidth(ch: string): number {
  const c = ch.codePointAt(0)!
  const wide =
    (c >= 0x1100 && c <= 0x115f) ||
    c === 0x2329 ||
    c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe10 && c <= 0xfe19) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x2fffd)
  return wide ? 2 : 1
}

export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charDisplayWidth(ch)
  return w
}

export function truncateTo(s: string, w: number): string {
  let out = ""
  let dw = 0
  for (const ch of s) {
    const cw = charDisplayWidth(ch)
    if (dw + cw > w) {
      out += "…"
      break
    }
    out += ch
    dw += cw
  }
  return out
}

function padRight(s: string, w: number): string {
  const pad = Math.max(0, w - displayWidth(s))
  return s + " ".repeat(pad)
}

// ---------- 行内解析 ----------

interface InlineSeg {
  text: string
  bold?: boolean
  dim?: boolean
  strike?: boolean
  code?: boolean
  accent?: boolean
  faint?: boolean
}

const INLINE_RE = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*)/g

function parseInline(text: string): InlineSeg[] {
  const out: InlineSeg[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith("**")) out.push({ text: tok.slice(2, -2), bold: true })
    else if (tok.startsWith("~~")) out.push({ text: tok.slice(2, -2), strike: true })
    else if (tok.startsWith("`")) out.push({ text: tok.slice(1, -1), code: true })
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]*)\]\(([^)]*)\)$/)
      if (mm) {
        out.push({ text: mm[1] ?? "", accent: true })
        if (mm[2]) out.push({ text: ` (${mm[2]})`, faint: true })
      }
    } else if (tok.startsWith("*")) out.push({ text: tok.slice(1, -1), dim: true })
    last = m.index + tok.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

function renderInline(segs: InlineSeg[], keyBase: string, t: ThemeTokens): ReactNode[] {
  return segs.map((s, i) => (
    <Text
      key={`${keyBase}-${i}`}
      color={s.code ? t.accent : s.faint ? t.inkFaint : undefined}
      bold={s.bold}
      dimColor={s.dim || s.strike}
      strikethrough={s.strike}
      backgroundColor={s.code ? t.codeBg : undefined}
    >
      {s.text}
    </Text>
  ))
}

// ---------- 代码块迷你高亮 ----------

const CODE_KEYWORDS =
  "const|let|var|function|return|if|else|for|while|import|from|export|def|class|new|true|false|null|undefined|async|await|try|catch|throw|type|interface|in|of|do|switch|case|break|continue|useEffect|useState"

const HIGHLIGHT_RE = new RegExp(
  `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')|(#[^\\n]*|\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(?:${CODE_KEYWORDS})\\b`,
  "g",
)

function highlightLine(line: string, t: ThemeTokens): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = HIGHLIGHT_RE.exec(line))) {
    if (m.index > last) out.push(<Text key={`p${k++}`}>{line.slice(last, m.index)}</Text>)
    const tok = m[0]
    if (m[1]) out.push(<Text key={`s${k++}`} color={t.accent}>{tok}</Text>)
    else if (m[2]) out.push(<Text key={`c${k++}`} color={t.inkFaint}>{tok}</Text>)
    else if (m[3]) out.push(<Text key={`n${k++}`} color={t.accentDim}>{tok}</Text>)
    else out.push(<Text key={`w${k++}`} bold>{tok}</Text>)
    last = m.index + tok.length
  }
  if (last < line.length) out.push(<Text key={`t${k++}`}>{line.slice(last)}</Text>)
  return out.length ? out : line
}

// ---------- 表格 ----------

function parseTableRow(line: string): string[] | null {
  const s = line.trim()
  if (!s.startsWith("|") || !s.endsWith("|")) return null
  return s
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim())
}

function isSepRow(row: string[]): boolean {
  return row.length > 0 && row.every((c) => /^:?-+:?$/.test(c))
}

function renderTable(rows: string[][], t: ThemeTokens, width: number): ReactNode {
  const body = rows.filter((r) => !isSepRow(r))
  if (body.length === 0) return null
  const nCols = Math.max(...body.map((r) => r.length))
  let widths = Array.from({ length: nCols }, (_, c) =>
    Math.min(26, Math.max(3, ...body.map((r) => displayWidth(r[c] ?? "")))),
  )
  let total = widths.reduce((a, b) => a + b + 3, 1)
  while (total > width && widths.some((w) => w > 6)) {
    const maxW = Math.max(...widths)
    const idx = widths.indexOf(maxW)
    widths[idx] = Math.max(6, widths[idx]! - 1)
    total = widths.reduce((a, b) => a + b + 3, 1)
  }
  return (
    <Box key="table" flexDirection="column">
      {body.map((r, ri) => {
        const cells: ReactNode[] = []
        for (let c = 0; c < nCols; c++) {
          const w = widths[c]!
          const cell = padRight(truncateTo(r[c] ?? "", w), w)
          cells.push(
            <Text key={`c${c}`} color={ri === 0 ? t.accent : t.ink} bold={ri === 0}>
              {cell}
            </Text>,
          )
          if (c < nCols - 1) cells.push(<Text key={`s${c}`} color={t.inkFaint}> │ </Text>)
        }
        return (
          <Text key={`r${ri}`} wrap="wrap">
            {cells}
          </Text>
        )
      })}
    </Box>
  )
}

// ---------- 主渲染器 ----------

/**
 * 把一段 Markdown 渲染为逐行 ReactNode。
 * @param width 内容区估算宽度(表格收缩/分隔线用), 传终端列数估算值
 */
export function renderMarkdown(text: string, t: ThemeTokens, width = 72): ReactNode[] {
  const rawLines = text.split("\n")
  const out: ReactNode[] = []
  let inCode = false
  let codeBuf: string[] = []

  const flushCode = (key: string): void => {
    if (!codeBuf.length) return
    out.push(
      <Box
        key={key}
        flexDirection="column"
        borderStyle="single"
        borderLeft
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderColor={t.inkFaint}
        backgroundColor={t.codeBg}
        paddingLeft={1}
      >
        {codeBuf.map((l, i) => (
          <Text key={`${key}-${i}`} wrap="wrap">
            {highlightLine(l, t)}
          </Text>
        ))}
      </Box>,
    )
    codeBuf = []
  }

  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]!
    const tl = line.trim()

    if (tl.startsWith("```")) {
      if (inCode) {
        inCode = false
        flushCode(`code-${i}`)
      } else {
        inCode = true
        codeBuf = []
      }
      i++
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      i++
      continue
    }

    const key = `l${i}`

    // 表格块(连续 | 行)
    if (tl.startsWith("|")) {
      const rows: string[][] = []
      let j = i
      while (j < rawLines.length) {
        const cells = parseTableRow(rawLines[j]!)
        if (!cells) break
        rows.push(cells)
        j++
      }
      if (rows.filter((r) => !isSepRow(r)).length >= 2) {
        out.push(renderTable(rows, t, width))
        i = j
        continue
      }
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(tl)) {
      out.push(<Box key={key} borderStyle="single" borderTop borderLeft={false} borderRight={false} borderBottom={false} borderColor={t.inkFaint} />)
      i++
      continue
    }

    // 标题(不显示 #, 用字重表达层级)
    const hMatch = tl.match(/^(#{1,4})\s+(.+)$/)
    if (hMatch) {
      const level = hMatch[1]!.length
      out.push(
        <Text key={key} bold color={level <= 2 ? t.accent : t.ink} wrap="wrap">
          {renderInline(parseInline(hMatch[2]!), key, t)}
        </Text>,
      )
      i++
      continue
    }

    // 任务列表
    const taskMatch = tl.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (taskMatch) {
      const done = taskMatch[1]!.toLowerCase() === "x"
      out.push(
        <Text key={key} wrap="wrap">
          <Text color={done ? t.ok : t.inkDim}>{done ? "✓" : "○"} </Text>
          <Text dimColor={done} color={done ? t.inkFaint : t.ink}>
            {renderInline(parseInline(taskMatch[2]!), key, t)}
          </Text>
        </Text>,
      )
      i++
      continue
    }

    // 无序列表(带缩进层级)
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (ulMatch) {
      const level = Math.min(4, Math.floor(ulMatch[1]!.length / 2))
      out.push(
        <Text key={key} wrap="wrap">
          <Text color={t.inkFaint}>{"  ".repeat(level)}• </Text>
          {renderInline(parseInline(ulMatch[2]!), key, t)}
        </Text>,
      )
      i++
      continue
    }

    // 有序列表
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/)
    if (olMatch) {
      const level = Math.min(4, Math.floor(olMatch[1]!.length / 2))
      out.push(
        <Text key={key} wrap="wrap">
          <Text color={t.inkFaint}>
            {"  ".repeat(level)}
            {olMatch[2]}.
          </Text>
          <Text> {renderInline(parseInline(olMatch[3]!), key, t)}</Text>
        </Text>,
      )
      i++
      continue
    }

    // 引用
    if (tl.startsWith(">")) {
      const q = line.replace(/^(\s*)>\s?/, "")
      out.push(
        <Text key={key} color={t.inkDim} wrap="wrap">
          <Text color={t.accentDim}>│ </Text>
          {renderInline(parseInline(q), key, t)}
        </Text>,
      )
      i++
      continue
    }

    if (tl === "") {
      out.push(<Text key={key}> </Text>)
      i++
      continue
    }

    out.push(
      <Text key={key} wrap="wrap">
        {renderInline(parseInline(line), key, t)}
      </Text>,
    )
    i++
  }
  flushCode("code-end")
  return out
}
