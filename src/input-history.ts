// 输入历史 —— Ctrl+↑/↓ 回填已提交输入(纯函数, 便于单元测试)。
// 语义: 列表头部为最新; idx=-1 表示"未浏览"(输入框内容即草稿), 向上起始即最新一条。

export function walkHistory(entries: string[], idx: number, dir: 1 | -1, draft: string): { idx: number; value: string } {
  if (entries.length === 0) return { idx, value: draft }
  if (dir === -1) {
    const next = idx === -1 ? 0 : Math.min(entries.length - 1, idx + 1)
    return { idx: next, value: entries[next]! }
  }
  if (idx === -1) return { idx, value: draft }
  const next = idx + 1
  if (next >= entries.length) return { idx: -1, value: draft }
  return { idx: next, value: entries[next]! }
}

/** 提交后记住输入: 去重置顶, 上限防止无限膨胀 */
export function rememberInput(entries: string[], value: string, cap = 50): string[] {
  const v = value.trim()
  if (!v) return entries
  return [v, ...entries.filter((e) => e !== v)].slice(0, cap)
}