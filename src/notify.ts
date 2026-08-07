// Attention 完成提醒(对齐 opencode attention)。
// MINICODE_ATTENTION=1 时启用: 终端响铃 + macOS 桌面通知。
// 默认关闭 —— 通知类功能必须显式选择, 不打扰。

import { log } from "./log.ts"

function enabled(): boolean {
  return process.env.MINICODE_ATTENTION === "1"
}

/** 终端响铃(所有平台都安全)。 */
export function bell(): void {
  if (!enabled()) return
  try {
    process.stdout.write("\x07")
  } catch {
    // 非 TTY 时忽略
  }
}

/** 构建完成/失败/权限询问时请求注意。 */
export function notify(title: string, body: string): void {
  if (!enabled()) return
  bell()
  if (process.platform !== "darwin") return
  const safe = (s: string): string => s.replace(/["\\]/g, "").slice(0, 120)
  void import("node:child_process").then(({ exec }) => {
    exec(`osascript -e 'display notification "${safe(body)}" with title "${safe(title)}"'`, (err) => {
      if (err) log.debug("notify", "桌面通知失败", { error: String(err) })
    })
  })
}
