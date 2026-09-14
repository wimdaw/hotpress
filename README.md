# HotPress — 热点创作推送工作台

全网热点 → 自动选题 → AI 创作 → 智能配图 → 微信公众号草稿箱，一条流水线跑通。
基于 Cloudflare **Pages + D1**（也支持 Workers 部署），无需服务器、无需备案。

## 架构与数据流

```
┌────────────────────────────────────────────────────────────────┐
│  ① 热点抓取（hot-topics 移植）                                   │
│     60s API 8 实例故障转移 + tophub 兜底 + IT之家/36氪/爱范儿 RSS  │
│     微博 / 知乎 / 百度 / 抖音 / 头条 / 小红书 / B站 / 腾讯 / 微信   │
├────────────────────────────────────────────────────────────────┤
│  ② 自动选题（selector）                                         │
│     标题 bigram 相似度跨平台合并 · 热度归一化打分 · 多平台加权      │
│     关键词偏好 / 排除 · 选 TOP N 入选题池                         │
├────────────────────────────────────────────────────────────────┤
│  ③ AI 创作（writer + llm，wewrite 模板规范）                     │
│     四体裁模板：快讯速递 / 深度解读 / 盘点清单 / 观点评论          │
│     标题 ≤64 字 · 摘要 ≤120 字 · 作者 ≤8 字（微信硬限制）         │
├────────────────────────────────────────────────────────────────┤
│  ④ 智能配图（images + agnes + cover）                           │
│     1) 网搜优先：百度 / Bing / Wikimedia / Openverse / DDG        │
│        + Pexels / Pixabay（可选 key）                            │
│        —— 水印图库域名黑名单硬过滤 + 图片探活校验                  │
│     2) 搜不到 → Agnes AI 文生图兜底                              │
│     3) 再不行 → 纯 TS 生成 900×383 渐变 PNG 封面保底              │
├────────────────────────────────────────────────────────────────┤
│  ⑤ 微信排版（markdown，wewrite 主题思想）                        │
│     Markdown → 内联样式微信 HTML，主题：clean / sspai / navy      │
├────────────────────────────────────────────────────────────────┤
│  ⑥ 推送（wxclient → wx-draft-worker）                           │
│     POST /api/draft · X-API-Key · 浏览器 UA（防 CF 1010）        │
│     微信错误码中文映射 · 失败最多重试 1 次 · 成败都落库            │
└────────────────────────────────────────────────────────────────┘
```

**页面**：`/` 首页（热点榜 + 成稿卡片 + 指标）· `/article/:id` 排版预览 · `/admin` 管理后台（与首页同一套设计系统）。

## 快速开始

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create hotpress-db
# 把返回的 database_id 填入 wrangler.toml 和 wrangler.pages.toml
```

### 2. 部署（二选一）

**方式 A：Cloudflare Pages（推荐，本项目即此方式部署）**

```bash
npm install && npm run build
# 临时把 wrangler.pages.toml 作为主配置（Pages 不支持自定义配置路径）
cp wrangler.pages.toml wrangler.toml
npx wrangler pages project create hotpress --production-branch main
npx wrangler pages deploy dist/pages --branch main
cp /备份的 wrangler.toml 回来
```

D1 绑定由 `wrangler.pages.toml` 的 `[[d1_databases]]` 提供；也可以在 Dashboard → Pages 项目 → Settings → Bindings 里手动绑定。

**方式 B：Cloudflare Workers（支持 cron 定时）**

```bash
npm run build && npx wrangler deploy
```

### 3. 设置环境变量 / Secrets

| 名称 | 必填 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 建议 | 后台密码（缺省 admin/admin，请务必修改） |
| `ADMIN_USERNAME` | 可选 | 后台用户名（缺省 admin） |
| `CRON_SECRET` | 建议 | 外部定时调 `/api/cron/run` 的密钥 |

Pages：`npx wrangler pages secret put ADMIN_PASSWORD --project-name hotpress`（设置后需重新部署一次生效）。

### 4. 首次配置（后台 → 设置）

打开 `https://你的域名/admin` 登录后：

- **LLM 创作**：默认指向 Kilo 网关免 key 免费模型（`stepfun/step-3.7-flash:free`，实测可用）。也可填自建 ai-gateway 的 `https://你的网关/v1` + 转发令牌 `sk_cf_*`。逗号分隔可填多个模型做回退。
- **Agnes AI 配图**：填 API Key（`apihub.agnes-ai.com/v1`，模型 `agnes-image-2.1-flash`）。网搜无结果时自动文生图兜底。
- **微信网关**：网关地址默认 `https://wx.seurl.eu.org`（已上线的 wx-draft-worker），填入在 wx-draft-worker 后台「令牌管理」创建的 `wxk_*` 令牌。点「网关健康」和「真实推送测试」验证。
- **配图图源**：默认 `baidu,bing,wikimedia,openverse,duckduckgo,pexels,pixabay`（顺序即优先级）。Pexels/Pixabay 免费申请 key 后填入即可启用。
- 每次修改后点「保存设置」，各面板均有「测试」按钮做连通性检查。

## 定时自动运行

| 部署方式 | 方案 |
|---|---|
| Workers | `wrangler.toml` 内 `[triggers] crons`（默认每天北京时间 08:30） |
| Pages | 外部定时器（cron-job.org 等）每早 `POST /api/cron/run`，请求头 `X-CRON-Secret: <设置的密钥>`；追加 `?push=1` 可同时自动推送 |

后台「流水线」页也可随时手动「完整运行 / 运行并推送 / 仅抓热点」，运行全程有日志。

## 公开 API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查（含 D1 连通） |
| `GET /api/topics?limit=20` | 当前热点榜（已跨平台合并） |
| `GET /api/articles?limit=20` | 已成稿文章列表 |
| `POST /api/cron/run` | 触发流水线（需 X-CRON-Secret） |

## 项目结构

```
src/
├── index.ts       # 路由入口（双部署形态 + scheduled cron）
├── topics.ts      # 热点抓取（60s 实例池 / tophub / RSS）
├── selector.ts    # 去重合并 + 打分选题
├── llm.ts         # OpenAI 兼容客户端（多模型回退）
├── writer.ts      # 创作模板（快讯/解读/盘点/观点）
├── markdown.ts    # 微信内联样式排版（3 主题）
├── images.ts      # 配图网搜 + 水印黑名单 + 探活
├── agnes.ts       # Agnes AI 文生图兜底
├── cover.ts       # 渐变 PNG 封面保底（纯 TS 编码）
├── wxclient.ts    # wx-draft-worker 推送客户端
├── pipeline.ts    # 流水线编排
├── storage.ts     # D1 数据层（5 表自动建表）
├── auth.ts        # 管理员会话
├── admin.ts       # 后台 API
├── pages.ts       # 首页 / 预览 / 后台 SPA
├── pages.css.ts   # 「Cloud Workbench」设计系统（沿用 ai-gateway）
└── shared.js.ts   # 共享工具 + 页脚
```

## 说明与限制

- **无水印承诺**：网搜结果按 `WATERMARK_DOMAINS` 黑名单（shutterstock/getty 系、国内素材站等 40+ 域名）过滤，图源本身只选免版权/免 key 渠道；任何环节都可将百度等搜索引擎源从「设置 → 图源顺序」移除。
- **60s API 上游有 5-15 分钟缓存**，抓取接口 5 分钟内自动去重。
- **Cloudflare 免费版子请求上限 50/请求**：默认一次流水线 1-3 篇文章在线额内；更大批量建议升级或分批运行。
- 免费模型不稳定时（返回为空/超时），系统自动加倍 max_tokens 重试并切换备用模型。
