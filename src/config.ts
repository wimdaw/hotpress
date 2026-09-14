import type { AppSettings } from './types'

export const SITE_CONFIG = {
  title: 'HotPress',
  subtitle: '热点创作推送工作台',
  descriptor: 'HOT TOPICS STUDIO',
  description: '全网热点自动选题、AI 创作、智能配图，一键推送微信公众号草稿箱',
  // 内联 SVG favicon，无外部依赖
  favicon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23f4f6fb'/%3E%3Cpath d='M6 22 12 10l5 8 4-5 5 9' fill='none' stroke='%233b6cf5' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

/** 必须带浏览器 UA：*.workers.dev 的 Bot 检测会拦截程序化 UA（CF 错误码 1010） */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export const SESSION_TTL = 7 * 24 * 60 * 60

export const DEFAULT_SETTINGS: AppSettings = {
  // 热点源：自托管全网热点聚合网关（/api/{platform}，失败自动回落 60s API 链路）
  topics_api_url: 'https://hot.seurl.eu.org',
  topics_api_key: '',
  // LLM：默认 Kilo 网关免 key 免费模型（实测可用），
  // 也可指向任意 OpenAI 兼容端点（如 https://你的ai-gateway/v1 + 转发令牌）
  llm_base_url: 'https://api.kilo.ai/api/gateway',
  llm_api_key: '',
  llm_model: 'stepfun/step-3.7-flash:free,kilo-auto/free',
  llm_temperature: '0.7',
  // Agnes AI 文生图（OpenAI 兼容）
  agnes_base_url: 'https://apihub.agnes-ai.com/v1',
  agnes_api_key: '',
  agnes_model: 'agnes-image-2.1-flash',
  // 配图：搜索优先（顺序即优先级），全失败再走 Agnes
  img_providers: 'wikimedia,openverse,toutiao,baidu,bing,duckduckgo,pexels,pixabay',
  img_pexels_key: '',
  img_pixabay_key: '',
  img_count: '3',
  // 微信网关：已上线的 wx-draft-worker
  wx_gateway_url: 'https://wx.seurl.eu.org',
  wx_api_token: '',
  wx_account_id: '',
  wx_author: '',
  auto_push: '0',
  select_count: '3',
  platforms: 'weibo,zhihu,baidu,douyin,toutiao,rednote',
  include_keywords: '',
  exclude_keywords: '',
  genre: 'auto',
  theme: 'clean',
  cron_secret: '',
  // 选题板块范围：流水线只从这些板块取材（空 = 不限）
  sector_scope: 'AI,科技,手机,数码硬件,汽车,机器人',
  // 定时任务（Pages 看门狗模式：站点请求触发；next_run_at 为 UTC ms）
  schedule_enabled: '0',
  schedule_time: '08:30',
  schedule_push: '0',
  next_run_at: '0',
  schedule_running_at: '0',
  last_scheduled_run: '0',
  // 每日自动抓取热点（fetch_times 支持一天多个 HH:mm）
  fetch_enabled: '0',
  fetch_times: '08:00,13:00,19:00',
  fetch_next_run_at: '0',
  fetch_running_at: '0',
  last_auto_fetch: '0',
  // 去 AI 化核验：推送前强制质检，超标阻断
  humanize_enabled: '1',
  humanize_threshold: '40',
  humanize_max_rounds: '2',
  last_fetch_at: '0',
}

/** 60s API 实例池（与 hot-topics fetch_60s.py 一致，官方 + 社区镜像） */
export const SIXTY_INSTANCES = [
  'https://60s.viki.moe',
  'https://60s.superjeason.qzz.io',
  'https://60s.zellon.top',
  'https://api.cczo.cc/60s',
  'https://60s.mizhoubaobei.top',
  'https://60s.7se.cn',
  'https://api.elysiayanyu.top',
  'https://60s.crystelf.top',
]

/** 平台 → 60s endpoint / tophub 兜底 board_id */
export const PLATFORMS: Record<string, { name: string; endpoint?: string; tophub?: string }> = {
  weibo: { name: '微博', endpoint: 'weibo', tophub: 'KqndgxeLl9' },
  zhihu: { name: '知乎', endpoint: 'zhihu', tophub: 'mproPpoq6O' },
  baidu: { name: '百度', endpoint: 'baidu/hot', tophub: 'Jb0vmloB1G' },
  douyin: { name: '抖音', endpoint: 'douyin' },
  toutiao: { name: '今日头条', endpoint: 'toutiao' },
  rednote: { name: '小红书', endpoint: 'rednote' },
  bili: { name: 'B站', endpoint: 'bili', tophub: '74KvxwokxM' },
  tencent_news: { name: '腾讯新闻', tophub: '12owgX0oNV' },
  wechat_gzh: { name: '微信公众号', tophub: 'WnBe01o371' },
  kuaishou: { name: '快手热榜' },
  tieba: { name: '贴吧热议' },
  netease: { name: '网易新闻' },
  thepaper: { name: '澎湃新闻' },
  bilibili_video: { name: 'B站热门视频' },
  ithome: { name: 'IT之家' },
  ifanr: { name: '爱范儿' },
  sspai: { name: '少数派热文' },
  github: { name: 'GitHub Trending' },
  hackernews: { name: 'Hacker News' },
  x: { name: 'X(推特)热榜' },
  voa: { name: '美国之音' },
  bbc: { name: 'BBC 中文网' },
  dw: { name: '德国之声' },
  rfi: { name: '法广 RFI' },
  zaobao: { name: '联合早报·国际' },
  xianbao: { name: '线报酷' },
}

/** hotpress 平台 key → 热点网关 /api/{id} 的平台 id */
export const HOT_API_IDS: Record<string, string> = {
  weibo: 'weibo', zhihu: 'zhihu', baidu: 'baidu', douyin: 'douyin', toutiao: 'toutiao',
  rednote: 'rednote', bili: 'bilibili', bilibili_video: 'bilibili-video',
  tencent_news: 'tencent', wechat_gzh: 'weixin', kuaishou: 'kuaishou', tieba: 'tieba',
  netease: 'netease', thepaper: 'thepaper', ithome: 'ithome', ifanr: 'ifanr',
  sspai: 'sspai', github: 'github', hackernews: 'hackernews', x: 'x',
  voa: 'voa', bbc: 'bbc', dw: 'dw', rfi: 'rfi', zaobao: 'zaobao', xianbao: 'xianbao',
}

/** 垂直媒体 RSS（补充热点来源） */
export const RSS_SOURCES: Record<string, { name: string; url: string }> = {
  ithome: { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  '36kr': { name: '36氪', url: 'https://www.36kr.com/feed' },
  ifanr: { name: '爱范儿', url: 'https://www.ifanr.com/feed' },
}

/**
 * 水印图库域名黑名单 —— 配图硬性过滤，命中的 URL 一律弃用。
 * 覆盖国际图库（shutterstock/getty 系等）与国内素材站（普遍打水印）。
 */
export const WATERMARK_DOMAINS = [
  'shutterstock.com', 'gettyimages.', 'istockphoto.com', 'istock.com',
  '123rf.com', 'dreamstime.com', 'alamy.com', 'depositphotos.com',
  'stock.adobe.com', 'adobestock', 'stockphoto', 'freepik.com',
  'vecteezy.com', 'vectorstock.com', 'storyblocks.com', 'videoblocks',
  'colourbox.com', 'fotosearch.com', 'agefotostock', 'dissolve.com',
  'zcool.com.cn', 'ibaotu.com', 'gaoding.com', '51yuansu.com',
  '818ps.com', 'nipic.com', '699pic.com', 'quanjing.com', 'vcg.com',
  'photophoto.cn', 'ttpai.cn', '588ku.com', '90design.com', 'pconline.com.cn',
  'dfic.', 'icphoto', 'cfp.cn', 'tata580.com', '58pic.com', 'nipic',
]

/** 创作模板（公众号爆款标准：默认 1800 字左右；结合 wewrite 契约 digest ≤120、author ≤8） */
export const GENRES: Record<string, { name: string; desc: string; length: string }> = {
  deep: { name: '深度解读', desc: '是什么→为什么→对我意味着什么，爆款主力体裁', length: '1700-1900字' },
  list: { name: '盘点清单', desc: '3 节递进式盘点，节奏轻快', length: '1700-1900字' },
  opinion: { name: '观点评论', desc: '立场鲜明，论证犀利', length: '1700-1900字' },
  brief: { name: '热点快评', desc: '快而不浅：事件+独到观察+延伸思考', length: '1100-1400字' },
}
