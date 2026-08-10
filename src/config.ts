// 用户配置 —— <项目>.minicode/config.json(可用 MINICODE_HOME 覆盖根目录, MINICODE_CONFIG 覆盖文件)
//   - 加载防御式: 文件损坏/不存在时回退空配置, 不崩溃
//   - 保存原子写: 先写临时文件再 rename
//   - 密钥文件权限 0600
//   - 生效优先级: 环境变量 > 当前 provider 快照 > 顶层遗留字段(视为 "default" provider)
//   - 多 provider: config.{provider: 当前名, providers: {名字: {url, apiKey, model}}};
//     顶层 llmUrl/llmApiKey/llmModel 是 "default" provider 的向后兼容形态;
//     LLM_PROVIDER 环境变量可临时指定当前 provider(优先级高于配置 provider 字段)
//
// 测试隔离: 测试通过 MINICODE_HOME 指向临时目录, 与生产读取链完全一致

import { join, dirname } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"
import { configFile } from "./paths.ts"

export interface ProviderProfile {
  url?: string
  apiKey?: string
  model?: string
}

export interface MinicodeConfig {
  llmUrl?: string
  llmApiKey?: string
  llmModel?: string
  /** 主题外观(dark/light), 设置面板切换后持久化 */
  theme?: "dark" | "light"
  /** 紧凑消息间距 */
  dense?: boolean
  /** 命名 provider 快照集 */
  providers?: Record<string, ProviderProfile>
  /** 当前 provider(缺省 "default") */
  provider?: string
  /** 底部状态行开关(v0.7, 默认开) */
  statusline?: boolean
  /** 上下文窗口上限(tokens), 用于 context 占用提醒; 默认 32000 */
  contextLimit?: number
  /** 长回答完成后终端通知(BEL/OSC9, 默认开) */
  notify?: boolean
}

export const DEFAULT_PROVIDER = "default"

/** context 提醒/状态行的窗口上限默认值(tokens) */
export const DEFAULT_CONTEXT_LIMIT = 32_000

export function configPath(cwd?: string): string {
  return process.env.MINICODE_CONFIG || configFile(cwd)
}

function readRaw(cwd?: string): MinicodeConfig {
  const path = configPath(cwd)
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const out: MinicodeConfig = {}
    if (typeof raw.llmUrl === "string" && raw.llmUrl.trim()) out.llmUrl = raw.llmUrl.trim()
    if (typeof raw.llmApiKey === "string" && raw.llmApiKey.trim()) out.llmApiKey = raw.llmApiKey.trim()
    if (typeof raw.llmModel === "string" && raw.llmModel.trim()) out.llmModel = raw.llmModel.trim()
    if (raw.theme === "dark" || raw.theme === "light") out.theme = raw.theme
    if (typeof raw.dense === "boolean") out.dense = raw.dense
    if (typeof raw.provider === "string" && raw.provider.trim()) out.provider = raw.provider.trim()
    if (typeof raw.statusline === "boolean") out.statusline = raw.statusline
    if (typeof raw.contextLimit === "number" && raw.contextLimit > 0) out.contextLimit = raw.contextLimit
    if (typeof raw.notify === "boolean") out.notify = raw.notify
    if (raw.providers && typeof raw.providers === "object") {
      out.providers = {}
      for (const [name, p] of Object.entries(raw.providers as Record<string, unknown>)) {
        if (!p || typeof p !== "object") continue
        const pp = p as Record<string, unknown>
        const prof: ProviderProfile = {}
        if (typeof pp.url === "string" && pp.url.trim()) prof.url = pp.url.trim()
        if (typeof pp.apiKey === "string" && pp.apiKey.trim()) prof.apiKey = pp.apiKey.trim()
        if (typeof pp.model === "string" && pp.model.trim()) prof.model = pp.model.trim()
        if (Object.keys(prof).length) out.providers[name] = prof
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveRaw(raw: MinicodeConfig, cwd?: string): void {
  const path = configPath(cwd)
  const tmp = path + ".tmp"
  mkdirSync(dirname(path), { recursive: true })
  const body = JSON.stringify(raw, null, 2) + "\n"
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** 当前 provider 名: 环境变量 LLM_PROVIDER > 配置文件 provider 字段 > "default" */
export function activeProvider(cwd?: string): string {
  const envName = process.env.LLM_PROVIDER?.trim()
  if (envName) return envName
  return readRaw(cwd).provider?.trim() || DEFAULT_PROVIDER
}

/** 命名 provider 列表(遗留顶层字段折算进 default) + 当前名 */
export function listProviders(cwd?: string): { current: string; names: string[] } {
  const raw = readRaw(cwd)
  const names = new Set<string>()
  for (const n of Object.keys(raw.providers ?? {})) names.add(n)
  if (raw.llmUrl || raw.llmApiKey || raw.llmModel) names.add(DEFAULT_PROVIDER)
  if (names.size === 0) names.add(DEFAULT_PROVIDER)
  return { current: activeProvider(cwd), names: [...names] }
}

/** 防御式加载: 当前 provider 生效后的配置(theme/dense 在顶层, LLM 三字段取当前快照) */
export function loadConfig(cwd?: string): MinicodeConfig {
  const raw = readRaw(cwd)
  const prof = raw.providers?.[activeProvider(cwd)] ?? ({} as ProviderProfile)
  const out: MinicodeConfig = {}
  if (raw.theme) out.theme = raw.theme
  if (typeof raw.dense === "boolean") out.dense = raw.dense
  if (typeof raw.statusline === "boolean") out.statusline = raw.statusline
  if (typeof raw.contextLimit === "number" && raw.contextLimit > 0) out.contextLimit = raw.contextLimit
  if (typeof raw.notify === "boolean") out.notify = raw.notify
  if (prof.url || raw.llmUrl) out.llmUrl = prof.url || raw.llmUrl
  if (prof.apiKey || raw.llmApiKey) out.llmApiKey = prof.apiKey || raw.llmApiKey
  if (prof.model || raw.llmModel) out.llmModel = prof.model || raw.llmModel
  return out
}

/** (重)建 provider 快照并切换为当前; 首次调用会把遗留顶层字段折算进 default */
export function switchProvider(name: string, cwd?: string): void {
  const clean = name.trim() || DEFAULT_PROVIDER
  const raw = readRaw(cwd)
  if (!raw.providers || Object.keys(raw.providers).length === 0) {
    if (raw.llmUrl || raw.llmApiKey || raw.llmModel) {
      raw.providers = { [DEFAULT_PROVIDER]: { url: raw.llmUrl, apiKey: raw.llmApiKey, model: raw.llmModel } }
    } else {
      raw.providers = {}
    }
  }
  if (!raw.providers[clean]) raw.providers[clean] = {}
  raw.provider = clean
  saveRaw(raw, cwd)
}

/** 保存当前 provider 的 LLM 快照(theme/dense 等顶层字段一并携带) */
export function saveProviderProfile(profile: ProviderProfile, cwd?: string, extra?: { theme?: "dark" | "light"; dense?: boolean }): void {
  const raw = readRaw(cwd)
  if (!raw.providers || Object.keys(raw.providers).length === 0) {
    if (raw.llmUrl || raw.llmApiKey || raw.llmModel) {
      raw.providers = { [DEFAULT_PROVIDER]: { url: raw.llmUrl, apiKey: raw.llmApiKey, model: raw.llmModel } }
    } else {
      raw.providers = {}
    }
  }
  raw.providers[activeProvider(cwd)] = profile
  if (extra?.theme) raw.theme = extra.theme
  if (typeof extra?.dense === "boolean") raw.dense = extra.dense
  saveRaw(raw, cwd)
}

/** 原子写(保持旧语义: 顶层字段就地合并覆盖, providers/provider 结构原样保留) */
export function saveConfig(cfg: MinicodeConfig, cwd?: string): void {
  const raw = readRaw(cwd)
  if (cfg.llmUrl !== undefined) raw.llmUrl = cfg.llmUrl
  if (cfg.llmApiKey !== undefined) raw.llmApiKey = cfg.llmApiKey
  if (cfg.llmModel !== undefined) raw.llmModel = cfg.llmModel
  if (cfg.theme) raw.theme = cfg.theme
  if (typeof cfg.dense === "boolean") raw.dense = cfg.dense
  if (typeof cfg.statusline === "boolean") raw.statusline = cfg.statusline
  if (typeof cfg.contextLimit === "number" && cfg.contextLimit > 0) raw.contextLimit = cfg.contextLimit
  if (typeof cfg.notify === "boolean") raw.notify = cfg.notify
  if (cfg.providers) raw.providers = cfg.providers
  saveRaw(raw, cwd)
}

/** 把配置注入环境变量; 已存在的环境变量优先(不覆盖); 本模块/设置面板写入的键记入 forced, 供 provider 切换时撤销 */
const forced = new Set<string>()
export function applyConfigToEnv(cfg: MinicodeConfig): void {
  if (cfg.llmUrl && !process.env.LLM_URL && !process.env.API_URL) {
    process.env.LLM_URL = cfg.llmUrl
    forced.add("LLM_URL")
  }
  if (cfg.llmApiKey && !process.env.LLM_API_KEY && !process.env.API_KEY) {
    process.env.LLM_API_KEY = cfg.llmApiKey
    forced.add("LLM_API_KEY")
  }
  if (cfg.llmModel && !process.env.LLM_MODEL) {
    process.env.LLM_MODEL = cfg.llmModel
    forced.add("LLM_MODEL")
  }
}

/** 设置面板保存后登记注入的键(切换 provider 时一并撤销, 保持「用户环境变量恒优」) */
export function registerForcedEnv(key: "LLM_URL" | "LLM_API_KEY" | "LLM_MODEL"): void {
  forced.add(key)
}

/** 撤销进程内被配置/设置面板注入过的 LLM env(其余用户自设 env 保留), 供 /provider 切换后重算 */
export function resetForcedEnv(): void {
  for (const k of forced) delete process.env[k]
  forced.clear()
}