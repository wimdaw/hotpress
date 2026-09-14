export interface Env {
  DB: D1Database
  /** 环境变量可覆盖默认管理员；未设置时回落 D1 持久化凭据（初始 admin/admin） */
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  /** Workers cron 触发时经 env 校验；/api/cron/run 也用它鉴权 */
  CRON_SECRET?: string
}

/** 运行设置（D1 settings 表，键值存储；缺省回落 DEFAULT_SETTINGS） */
export interface AppSettings {
  // 热点源：自托管热点聚合网关（直连各平台官方接口）
  topics_api_url: string
  topics_api_key: string
  // LLM（OpenAI 兼容 /chat/completions，可指向自己的 ai-gateway）
  llm_base_url: string
  llm_api_key: string
  llm_model: string
  llm_temperature: string
  // Agnes AI 文生图（OpenAI 兼容 images/generations）
  agnes_base_url: string
  agnes_api_key: string
  agnes_model: string
  // 配图
  img_providers: string
  img_pexels_key: string
  img_pixabay_key: string
  img_count: string
  // 微信网关（wx-draft-worker）
  wx_gateway_url: string
  wx_api_token: string
  wx_account_id: string
  wx_author: string
  auto_push: string
  // 流水线
  select_count: string
  platforms: string
  include_keywords: string
  exclude_keywords: string
  genre: string
  theme: string
  cron_secret: string
  humanize_enabled: string
  humanize_threshold: string
  humanize_max_rounds: string
  // 选题板块范围（逗号分隔，空=不限）
  sector_scope: string
  // 定时任务：每日流水线
  schedule_enabled: string
  schedule_time: string
  schedule_push: string
  next_run_at: string
  schedule_running_at: string
  last_scheduled_run: string
  // 定时任务：每日自动抓取热点（支持一天多个时间点）
  fetch_enabled: string
  fetch_times: string
  fetch_next_run_at: string
  fetch_running_at: string
  last_auto_fetch: string
  // 运行时状态
  last_fetch_at: string
}

export type SettingsMap = Partial<AppSettings>

/** 单条热点（归一化后） */
export interface HotItem {
  title: string
  hot: string | number
  url: string
}

/** D1 topics 行 */
export interface TopicRow {
  id: number
  batch_id: string
  platform: string
  platform_name: string
  title: string
  hot_value: string
  hot_score: number
  url: string
  norm_key: string
  selected: number
  used: number
  fetched_at: string
  category: string | null
  sector: string | null
}

/** 跨平台合并后的选题组 */
export interface TopicGroup {
  key: string
  title: string
  hotValue: string
  score: number
  platforms: string[]
  urls: string[]
  rows: TopicRow[]
}

/** 配图记录 */
export interface ArticleImage {
  url: string
  source: string
  query: string
}

/** D1 articles 行 */
export interface ArticleRow {
  id: string
  topic_key: string
  title: string
  digest: string
  author: string
  genre: string
  theme: string
  markdown: string
  html: string
  ai_score: number | null
  ai_signals: string | null
  humanize_rounds: number | null
  origin: string | null
  cover_url: string
  cover_source: string
  images: string
  status: string
  push_media_id: string | null
  push_error: string | null
  pushed_at: string | null
  created_at: string
  updated_at: string
}

/** D1 runs 行 */
/** 自定义自动任务 */
export interface CustomTaskRow {
  id: string
  name: string
  enabled: number
  times: string
  action: string
  params: string
  next_run_at: number
  running_at: number
  last_run: string | null
  last_result: string | null
  created_at: string
}

export interface RunRow {
  id: string
  trigger: string
  status: string
  topics_fetched: number
  topics_selected: number
  articles_created: number
  pushed: number
  log: string
  started_at: string
  finished_at: string | null
}

/** LLM 返回的创作结果 */
export interface ArticleDraft {
  title: string
  digest: string
  author?: string
  markdown: string
  image_queries: string[]
  image_queries_en?: string[]
}

export interface WxPushResult {
  ok: boolean
  media_id?: string
  error?: string
  data?: any
}
