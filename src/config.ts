// 用户配置 —— <项目>.minicode/config.json(可用 MINICODE_HOME 覆盖根目录, MINICODE_CONFIG 覆盖文件)
//   - 加载防御式: 文件损坏/不存在时回退空配置, 不崩溃
//   - 保存原子写: 先写临时文件再 rename
//   - 密钥文件权限 0600
//   - 生效优先级: 环境变量 > 配置文件(配置只填充未设置的环境变量)
//
// 测试隔离: 测试通过 MINICODE_HOME 指向临时目录, 与生产读取链完全一致

import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"
import { configFile } from "./paths.ts"

export interface MinicodeConfig {
  llmUrl?: string
  llmApiKey?: string
  llmModel?: string
  /** 主题外观(dark/light), 设置面板切换后持久化 */
  theme?: "dark" | "light"
  /** 紧凑消息间距 */
  dense?: boolean
}

export function configPath(cwd?: string): string {
  return process.env.MINICODE_CONFIG || configFile(cwd)
}

/** 防御式加载: 任何异常(不存在/损坏/非法 JSON)都回退空配置 */
export function loadConfig(cwd?: string): MinicodeConfig {
  const path = configPath(cwd)
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const out: MinicodeConfig = {}
    if (typeof raw.llmUrl === "string" && raw.llmUrl.trim()) out.llmUrl = raw.llmUrl.trim()
    if (typeof raw.llmApiKey === "string" && raw.llmApiKey.trim()) out.llmApiKey = raw.llmApiKey.trim()
    if (typeof raw.llmModel === "string" && raw.llmModel.trim()) out.llmModel = raw.llmModel.trim()
    if (raw.theme === "dark" || raw.theme === "light") out.theme = raw.theme
    if (typeof raw.dense === "boolean") out.dense = raw.dense
    return out
  } catch {
    return {}
  }
}

/** 原子写: 临时文件 + rename, 避免半写状态; 密钥文件 0600 */
export function saveConfig(cfg: MinicodeConfig, cwd?: string): void {
  const path = configPath(cwd)
  const tmp = path + ".tmp"
  mkdirSync(dirname(path), { recursive: true })
  const body = JSON.stringify(cfg, null, 2) + "\n"
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** 把配置注入环境变量; 已存在的环境变量优先(不覆盖) */
export function applyConfigToEnv(cfg: MinicodeConfig): void {
  if (cfg.llmUrl && !process.env.LLM_URL && !process.env.API_URL) process.env.LLM_URL = cfg.llmUrl
  if (cfg.llmApiKey && !process.env.LLM_API_KEY && !process.env.API_KEY) process.env.LLM_API_KEY = cfg.llmApiKey
  if (cfg.llmModel && !process.env.LLM_MODEL) process.env.LLM_MODEL = cfg.llmModel
}
