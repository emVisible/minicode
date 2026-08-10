// 危险命令识别 —— 命令行模式执行前的静态闸门。
// 仅为启发式防护(覆盖常见破坏/提权/外部脚本/历史销毁), 命中后由用户在界面确认, 绝不静默放行。
// 规则清单刻意保守: 目标是少误报, 而不是穷尽 —— 复杂混淆不在此列。

export interface DangerRule {
  id: string
  pattern: RegExp
  hint: string
}

export const DANGER_RULES: readonly DangerRule[] = [
  { id: "rm-root", pattern: /(^|[\s;|&])rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?[^;|&\n]*(\/|~|\$HOME|\.)(\s|$)/i, hint: "删除根目录/家目录/当前目录" },
  { id: "rm-git", pattern: /rm [^;|&\n]*\.git\b/i, hint: "删除 .git 历史目录" },
  { id: "rm-dotfiles", pattern: /rm [^;|&\n]*\.minicode\b/i, hint: "删除应用配置/会话/日志目录" },
  { id: "fork-bomb", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:&\s*\}/, hint: "fork 炸弹" },
  { id: "disk-destroy", pattern: /(mkfs[.\w]*|diskutil eraseDisk|dd[^;]*of=\/dev\/|umount[^;]*\/dev\/|fdisk[^;]*\/dev\/)/i, hint: "磁盘/分区级操作" },
  { id: "power", pattern: /(^|[\s;|&])(shutdown|reboot|poweroff|halt|init\s+0)(\s|$)/, hint: "关机/重启" },
  { id: "git-push-force", pattern: /git push[^;]*(-f|--force)/i, hint: "强制推送覆盖远端历史" },
  { id: "pipe-shell", pattern: /(curl|wget)[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh|fish)\b/i, hint: "管道执行远端脚本" },
  { id: "eval-remote", pattern: /\beval\s*(\(|"|\$|')\s*(\$|"|')?\s*\(\s*(curl|wget)/i, hint: "eval 取远端命令输出执行" },
  { id: "dev-write", pattern: /(^|\s)(echo|printf)[^>]*>\s*\/dev\//, hint: "直接写设备文件" },
  { id: "chmod-root", pattern: /chmod -R 777 (\/|~|\$HOME)/i, hint: "根目录/家目录全局放开权限" },
]

/** 返回第一条命中的规则(命令串 → 危险? 命中即返回 {id, hint}) */
export function matchDanger(cmd: string): { id: string; hint: string } | null {
  for (const r of DANGER_RULES) {
    if (r.pattern.test(cmd)) return { id: r.id, hint: r.hint }
  }
  return null
}