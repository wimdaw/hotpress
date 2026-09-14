/**
 * 热点板块分类 —— 移植自 hot-topics skill fetch_sectors.py 的板块规则思想，
 * 用关键词命中给单条热点打板块标签（首中即定，未命中归「综合」）。
 * 用于后台热点池筛选与选题偏好。
 */

export const SECTOR_RULES: Array<{ sector: string; kws: string[] }> = [
  {
    sector: 'AI',
    kws: ['AI', '人工智能', '大模型', 'GPT', 'DeepSeek', 'OpenAI', 'Gemini', 'Claude', '算力', '智能体', 'Agent', '文生图', '文生视频', '多模态', '英伟达', 'GPU', 'AIGC', 'Copilot'],
  },
  {
    sector: '手机',
    kws: ['手机', 'iPhone', '苹果', '华为', '小米', 'OPPO', 'vivo', '荣耀', '三星', '折叠屏', 'Mate', 'Pura', 'iOS', '鸿蒙', '安卓', '旗舰机', '影像旗舰'],
  },
  {
    sector: '汽车',
    kws: ['汽车', '车企', '新能源车', '比亚迪', '特斯拉', '蔚来', '理想汽车', '小鹏', '问界', '智驾', '动力电池', '续航', '车展', '增程', '纯电'],
  },
  {
    sector: '机器人',
    kws: ['机器人', '人形机器人', '具身智能', '宇树', 'Optimus', '波士顿动力', '机器狗', '扫地机器人'],
  },
  {
    sector: '数码硬件',
    kws: ['芯片', '显卡', 'RTX', '骁龙', '天玑', '笔记本', '电脑', 'MacBook', '平板', '耳机', '手表', '相机', '无人机', '内存', '显示器', 'SSD', '路由器'],
  },
  {
    sector: '财经',
    kws: ['股价', '股市', 'A股', '美股', '港股', '基金', '汇率', '降息', '加息', '财报', '市值', 'IPO', '融资', '比特币', '加密货币', '黄金', '纳斯达克', '涨停'],
  },
  {
    sector: '文娱体育',
    kws: ['电影', '电视剧', '演唱会', '综艺', '明星', '票房', '游戏', '手游', '主播', '开播', '夺冠', '联赛', '奥运', '世界杯', '进球', '决赛', '春晚', '综艺'],
  },
  {
    sector: '社会民生',
    kws: ['辟谣', '警方', '通报', '事故', '救援', '台风', '暴雨', '高温', '放假', '工资', '社保', '医保', '教育', '开学', '招聘', '退休', '外卖员', '消费者'],
  },
  {
    sector: '国际',
    kws: ['美国', '日本', '俄罗斯', '欧盟', '特朗普', '普京', '关税', '制裁', '大选', '联合国', '冲突', '停火', '访华', '外交'],
  },
]

/** 给标题打板块标签：按规则顺序首中即定，未命中返回「综合」 */
export function tagSector(title: string): string {
  const t = String(title || '')
  for (const rule of SECTOR_RULES) {
    for (const kw of rule.kws) {
      if (t.includes(kw)) return rule.sector
    }
  }
  return '综合'
}

export const SECTOR_NAMES = SECTOR_RULES.map((r) => r.sector).concat(['综合'])

/** 平台所属大类（与自托管热点网关的分类一致） */
export const PLATFORM_CATEGORIES: Record<string, string> = {
  weibo: '综合', baidu: '综合', douyin: '综合', toutiao: '综合', kuaishou: '综合',
  rednote: '综合', xianbao: '综合',
  zhihu: '社区', bili: '社区', bilibili_video: '社区', tieba: '社区',
  tencent_news: '新闻', netease: '新闻', thepaper: '新闻', wechat_gzh: '新闻',
  ithome: '科技', ifanr: '科技', sspai: '科技', github: '科技', hackernews: '科技', '36kr': '科技',
  x: '国际', voa: '国际', bbc: '国际', dw: '国际', rfi: '国际', zaobao: '国际',
}

export const CATEGORY_NAMES = ['综合', '社区', '新闻', '科技', '国际']
