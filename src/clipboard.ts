// 剪贴板 —— 平台适配(pbcopy / clip.exe / xclip / xsel), 无外部依赖
// 用于 ctrl+x c(复制最后回答) / ctrl+x v(复制最后问题) 等快捷键

import { spawnSync } from "node:child_process"

export interface ClipboardResult {
  ok: boolean
  msg: string
}

/** 把文本写入系统剪贴板; 失败时给出平台提示 */
export function copyToClipboard(text: string): ClipboardResult {
  if (!text.trim()) return { ok: false, msg: "没有可复制的内容" }
  const clean = text.replace(/\r\n/g, "\n")
  const cmds: Array<{ cmd: string; args: string[] }> =
    process.platform === "darwin"
      ? [
          { cmd: "pbcopy", args: [] },
          { cmd: "osascript", args: ["-e", "set the clipboard to (do shell script \"cat\")"] },
        ]
      : process.platform === "win32"
        ? [{ cmd: "clip", args: [] }]
        : [
            { cmd: "xclip", args: ["-selection", "clipboard"] },
            { cmd: "xsel", args: ["--clipboard", "--input"] },
          ]

  for (const { cmd, args } of cmds) {
    try {
      const r = spawnSync(cmd, args, { input: clean, encoding: "utf8", timeout: 5000 })
      if (r.status === 0 && !r.error) return { ok: true, msg: `已复制 ${text.length} 字符到剪贴板` }
    } catch {
      // 尝试下一种
    }
  }
  return { ok: false, msg: "未找到剪贴板工具(macOS: pbcopy · Linux: xclip/xsel)" }
}