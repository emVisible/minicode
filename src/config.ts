// 用户配置 —— ~/.minicode/config.json(可用 MINICODE_CONFIG 覆盖路径)
//   - 加载防御式: 文件损坏/不存在时回退空配置, 不崩溃(技术宪章 17.3/17.4)
//   - 保存原子写: 先写临时文件再 rename(17.11)
//   - 密钥文件权限 0600(8.2)
//   - 生效优先级: 环境变量 > 配置文件(配置只填充未设置的环境变量)
//
// 测试隔离(实践第三十四节): 测试通过 MINICODE_CONFIG 指向临时文件, 与生产读取链完全一致

import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"

export interface MinicodeConfig {
  llmUrl?: string
  llmApiKey?: string
  llmModel?: string
}

const CONFIG_DIR = join(homedir(), ".minicode")
const DEFAULT_PATH = join(CONFIG_DIR, "config.json")

export function configPath(): string {
  return process.env.MINICODE_CONFIG || DEFAULT_PATH
}

/** 防御式加载: 任何异常(不存在/损坏/非法 JSON)都回退空配置 */
export function loadConfig(): MinicodeConfig {
  const path = configPath()
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const out: MinicodeConfig = {}
    if (typeof raw.llmUrl === "string" && raw.llmUrl.trim()) out.llmUrl = raw.llmUrl.trim()
    if (typeof raw.llmApiKey === "string" && raw.llmApiKey.trim()) out.llmApiKey = raw.llmApiKey.trim()
    if (typeof raw.llmModel === "string" && raw.llmModel.trim()) out.llmModel = raw.llmModel.trim()
    return out
  } catch {
    return {}
  }
}

/** 原子写: 临时文件 + rename, 避免半写状态; 密钥文件 0600 */
export function saveConfig(cfg: MinicodeConfig): void {
  const path = configPath()
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
