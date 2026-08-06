// 设计令牌 —— 克制式色彩体系
// 原则(A2/A3): 单一强调色(淡紫蓝) + 中性灰阶; 语义色(绿/红/黄)仅作裁定;
// 层级由字重/亮度/留白表达, 颜色始终是增强层而不是必需层。
// 主题解析顺序: MINICODE_THEME=dark|light > COLORFGBG 推断 > OSC 11 查询 > 默认 dark

export type ThemeName = "dark" | "light"

export interface ThemeTokens {
  name: ThemeName
  /** 强调色: 淡紫蓝(焦点/进行中/链接/交互) */
  accent: string
  /** 强调色的降级版(rail、弱强调) */
  accentDim: string
  /** 主文本 */
  ink: string
  /** 次级文本 */
  inkDim: string
  /** 最暗文本(诊断/水印/时间戳) */
  inkFaint: string
  /** 裁定: 成功 */
  ok: string
  /** 裁定: 警告 */
  warn: string
  /** 裁定: 错误 */
  err: string
  /** 代码块/行内代码微底色(终端不支持背景色时为 undefined) */
  codeBg: string | undefined
}

const DARK: ThemeTokens = {
  name: "dark",
  accent: "#AEB6F0",
  accentDim: "#7984D8",
  ink: "#F0F1F4",
  inkDim: "#9BA1AD",
  inkFaint: "#5C6270",
  ok: "#6FD08C",
  warn: "#E0C06A",
  err: "#E06C75",
  codeBg: "#1B1D26",
}

const LIGHT: ThemeTokens = {
  name: "light",
  accent: "#5C6BC0",
  accentDim: "#7E8AD6",
  ink: "#1C1E26",
  inkDim: "#565C6C",
  inkFaint: "#9AA0B0",
  ok: "#2E9E5B",
  warn: "#B8860B",
  err: "#C0392B",
  codeBg: "#F2F3F7",
}

export function tokens(name: ThemeName): ThemeTokens {
  return name === "light" ? LIGHT : DARK
}

/** 同步可得的主题(env / COLORFGBG), 无查询延迟 */
export function initialThemeName(): ThemeName {
  const override = process.env.MINICODE_THEME?.toLowerCase()
  if (override === "light") return "light"
  if (override === "dark") return "dark"
  const cf = process.env.COLORFGBG
  if (cf) {
    const bg = Number(cf.split(";")[1])
    if (!Number.isNaN(bg)) return bg >= 8 ? "light" : "dark"
  }
  return "dark"
}

/**
 * 异步检测终端主题: ANSI OSC 11 查询背景色(400ms 超时)。
 * 仅在 cli.ts 启动渲染前调用(此时 stdin 尚未被 Ink 接管)。
 */
export async function detectTerminalTheme(): Promise<ThemeName | null> {
  const override = process.env.MINICODE_THEME?.toLowerCase()
  if (override === "light") return "light"
  if (override === "dark") return "dark"
  const cf = process.env.COLORFGBG
  if (cf) {
    const bg = Number(cf.split(";")[1])
    if (!Number.isNaN(bg)) return bg >= 8 ? "light" : "dark"
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  return new Promise((resolve) => {
    let buf = ""
    let settled = false
    const prevRaw = process.stdin.isRaw
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.off("data", onData)
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(prevRaw)
      } catch {
        // 终端不支持 raw 模式, 忽略
      }
      process.stdin.pause()
    }
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8")
      const m = buf.match(/\x1b]11;rgb:([0-9a-fA-F]{2})\/([0-9a-fA-F]{2})\/([0-9a-fA-F]{2})/)
      if (!m) return
      done()
      const lum = (parseInt(m[1]!, 16) * 299 + parseInt(m[2]!, 16) * 587 + parseInt(m[3]!, 16) * 114) / 1000
      resolve(lum > 150 ? "light" : "dark")
    }
    const timer = setTimeout(() => {
      done()
      resolve(null)
    }, 400)
    try {
      process.stdin.setRawMode(true)
    } catch {
      done()
      resolve(null)
      return
    }
    process.stdin.on("data", onData)
    process.stdin.resume()
    process.stdout.write("\x1b]11;?\x07")
  })
}
