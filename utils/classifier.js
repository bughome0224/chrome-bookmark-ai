/**
 * AI 书签分类模块
 * 提供商和模型配置由 config.json 驱动，支持动态扩展
 * 降级策略：API 失败时使用本地关键词匹配
 */

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT = 15000;

let _configPromise = null;

function loadProviderConfig() {
  if (!_configPromise) {
    _configPromise = fetch(chrome.runtime.getURL('config.json')).then(r => r.json());
  }
  return _configPromise;
}

/**
 * 从 chrome.storage 获取用户设置
 */
async function getUserSettings() {
  const result = await chrome.storage.sync.get(['provider', 'model', 'apiKey']);
  return {
    provider: result.provider || DEFAULT_PROVIDER,
    model: result.model || DEFAULT_MODEL,
    apiKey: result.apiKey || ''
  };
}

/**
 * 构建分类 Prompt
 */
function buildPrompt(pageInfo, folders) {
  const folderList = folders.length > 0
    ? folders.map(f => `- ${f.title}`).join('\n')
    : '（用户当前没有任何书签文件夹）';

  return `你是一个书签分类助手。用户想要收藏一个网页，你需要根据网页内容和用户现有的书签文件夹结构，判断该网页最适合存放在哪个文件夹。

## 网页信息
- 标题：${pageInfo.title}
- URL：${pageInfo.url}
- 描述：${pageInfo.description || '无'}

## 用户现有书签文件夹
${folderList}

## 重要规则
- **只能**从上述「用户现有书签文件夹」列表中选择 folderName，**严禁编造或修改文件夹名称**
- folderName 必须与列表中的名称**完全一致**（包括大小写、中英文、标点符号）
- 如果现有文件夹都不合适，matchType 设为 "new"，并给出一个简洁的新文件夹建议名称

## 输出要求
严格返回以下 JSON 格式，不要包含 markdown 代码块标记，只返回纯 JSON：

{
  "matchType": "existing",
  "suggestions": [
    {"folderName": "技术文档", "confidence": 0.95, "reason": "该文章是关于React框架的技术文档"}
  ],
  "newFolderSuggestion": null
}

## 判断标准
- confidence >= 0.7 → 视为有良好匹配
- confidence 在 0.4-0.7 → 作为次选，但仍展示
- 所有 confidence < 0.4 → matchType 设为 "new"，建议新建文件夹
- 如果没有现有文件夹，matchType 设为 "new"，建议 2-3 个分类文件夹名`;
}

/**
 * 通用 API 调用（根据 config.json 中的 apiFormat 自动适配）
 */
async function callProviderAPI(prompt, providerInfo, model, apiKey) {
  if (providerInfo.apiFormat === 'anthropic') {
    return callAnthropicFormat(prompt, providerInfo.apiUrl, model, apiKey);
  }
  return callOpenAIFormat(prompt, providerInfo.apiUrl, model, apiKey);
}

async function callAnthropicFormat(prompt, apiUrl, model, apiKey) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function callOpenAIFormat(prompt, apiUrl, model, apiKey) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * 清理 AI 返回文本中的 markdown 代码块标记
 */
function cleanJsonResponse(text) {
  return text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * 解析 AI 返回的分类结果
 */
function parseClassification(text, folders) {
  const cleaned = cleanJsonResponse(text);
  const result = JSON.parse(cleaned);

  const folderMap = new Map(folders.map(f => [f.title, f.id]));
  const suggestions = (result.suggestions || []).map(s => ({
    ...s,
    folderId: folderMap.get(s.folderName) || null
  }));

  // 如果 AI 声称匹配到现有文件夹，但所有 folderName 在实际列表中都不存在
  // 说明 AI 产生了幻觉，降级为新建文件夹模式
  if (result.matchType === 'existing') {
    const validSuggestions = suggestions.filter(s => s.folderId !== null);
    if (validSuggestions.length === 0) {
      const fallbackName = suggestions[0]?.folderName || result.newFolderSuggestion;
      return {
        matchType: 'new',
        suggestions: [],
        newFolderSuggestion: fallbackName
      };
    }
    return {
      matchType: 'existing',
      suggestions: validSuggestions,
      newFolderSuggestion: result.newFolderSuggestion || null
    };
  }

  return {
    matchType: result.matchType || 'new',
    suggestions,
    newFolderSuggestion: result.newFolderSuggestion || null
  };
}

/**
 * 本地关键词匹配（降级策略）
 */
function localKeywordMatch(pageInfo, folders) {
  if (folders.length === 0) {
    return {
      matchType: 'new',
      suggestions: [],
      newFolderSuggestion: guessFolderName(pageInfo)
    };
  }

  const text = `${pageInfo.title} ${pageInfo.url} ${pageInfo.description || ''}`.toLowerCase();
  const hostname = extractHostname(pageInfo.url);

  const domainKeywords = {
    'github.com': ['开发', '编程', '技术', '代码', '开源'],
    'stackoverflow.com': ['开发', '编程', '技术', '问答'],
    'zhihu.com': ['知乎', '问答', '知识'],
    'juejin.cn': ['开发', '前端', '技术', '编程'],
    'bilibili.com': ['视频', 'b站', '娱乐'],
    'youtube.com': ['视频', 'youtube', '娱乐'],
    'zh.wikipedia.org': ['百科', '知识', 'wiki'],
    'docs.google.com': ['文档', '工作'],
    'mp.weixin.qq.com': ['微信', '公众号', '文章'],
    'twitter.com': ['社交', 'twitter', '资讯'],
    'reddit.com': ['社区', '论坛', '资讯'],
    'medium.com': ['文章', '博客', '技术'],
    'arxiv.org': ['论文', '学术', '研究'],
  };

  let keywords = [];
  for (const [domain, kws] of Object.entries(domainKeywords)) {
    if (hostname.includes(domain)) keywords.push(...kws);
  }

  const titleWords = pageInfo.title
    .toLowerCase()
    .replace(/[|｜\-—–·•·\s]+/g, ' ')
    .split(' ')
    .filter(w => w.length > 1);

  keywords.push(...titleWords);

  const scored = folders.map(f => {
    const folderName = f.title.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (folderName.includes(kw)) score += 1;
      if (kw.includes(folderName)) score += 0.5;
    }

    const bigrams = (s) => {
      const b = new Set();
      for (let i = 0; i < s.length - 1; i++) b.add(s.substring(i, i + 2));
      return b;
    };
    const a = bigrams(folderName);
    const b = bigrams(text);
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    const jaccard = intersection.size / (union.size || 1);
    score += jaccard * 2;

    return { folderName: f.title, folderId: f.id, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const maxScore = scored[0]?.score || 0;

  if (maxScore >= 1.5) {
    return {
      matchType: 'existing',
      suggestions: scored.slice(0, 3).map(s => ({
        folderName: s.folderName,
        folderId: s.folderId,
        confidence: Math.min(s.score / 5, 0.95),
        reason: '基于关键词匹配'
      })),
      newFolderSuggestion: null
    };
  }

  return {
    matchType: 'new',
    suggestions: maxScore > 0.5 ? scored.slice(0, 1).map(s => ({
      folderName: s.folderName,
      folderId: s.folderId,
      confidence: s.score / 5,
      reason: '低置信度匹配'
    })) : [],
    newFolderSuggestion: guessFolderName(pageInfo)
  };
}

function guessFolderName(pageInfo) {
  const hostname = extractHostname(pageInfo.url);
  const title = pageInfo.title.toLowerCase();

  const categoryMap = [
    { keys: ['github', 'gitlab', 'stackoverflow', 'npm', 'pypi', 'docker', '编程', '代码', '开发', '前端', '后端', 'api', 'react', 'vue', 'python', 'java', 'go', 'rust', 'js', 'ts', 'css', 'html', 'tutorial', 'doc', 'guide'], name: '技术开发' },
    { keys: ['新闻', 'news', '资讯', '日报', '时报', '头条', '快讯', '热点', 'blog', 'article'], name: '新闻资讯' },
    { keys: ['视频', 'video', 'bilibili', 'youtube', 'tv', 'movie', 'film', '剧', '综艺', '动漫', '直播'], name: '视频娱乐' },
    { keys: ['音乐', 'music', '歌', 'spotify', 'audio', 'podcast', '播客', '电台'], name: '音乐播客' },
    { keys: ['论文', 'paper', 'research', 'arxiv', '学术', 'science', 'scientific', 'journal', 'study'], name: '学术研究' },
    { keys: ['设计', 'design', 'ui', 'ux', 'figma', 'sketch', 'dribbble', 'behance', '配色', '字体', 'icon'], name: '设计资源' },
    { keys: ['购物', 'shop', 'store', 'buy', 'mall', '淘宝', '京东', 'amazon', 'price', 'deal', '折扣'], name: '购物' },
    { keys: ['工具', 'tool', 'util', 'generator', 'converter', 'calculator', 'checker', 'formatter', '在线工具'], name: '在线工具' },
    { keys: ['wiki', '百科', 'encyclopedia', '知识', '参考', 'reference'], name: '知识百科' },
    { keys: ['社区', 'forum', 'reddit', 'v2ex', 'community', 'discuss', '问答', 'q&a'], name: '社区论坛' },
    { keys: ['微信', 'wechat', '公众号', 'mp.'], name: '微信文章' },
    { keys: ['ai', '机器学习', '深度学习', 'ml', 'dl', 'llm', 'gpt', 'claude', 'chatgpt', 'model', 'neural', 'transformer', '人工智能'], name: 'AI人工智能' },
  ];

  for (const cat of categoryMap) {
    for (const key of cat.keys) {
      if (hostname.includes(key) || title.includes(key)) return cat.name;
    }
  }

  const parts = hostname.split('.');
  if (parts.length >= 2) {
    const main = parts[parts.length - 2];
    if (main && main.length > 2 && !['com', 'org', 'net', 'edu', 'gov'].includes(main)) {
      return main.charAt(0).toUpperCase() + main.slice(1);
    }
  }

  return '未分类';
}

function extractHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 主分类函数
 * @param {Object} pageInfo - { title, url, description }
 * @param {Array} folders - [{ id, title }, ...]
 * @returns {Object} 分类结果
 */
async function classify(pageInfo, folders) {
  const settings = await getUserSettings();

  if (!settings.apiKey) {
    return localKeywordMatch(pageInfo, folders);
  }

  // 查找对应提供商配置
  const config = await loadProviderConfig();
  const providerInfo = config.providers.find(p => p.id === settings.provider);
  if (!providerInfo) {
    console.warn(`[智能收藏夹] 未知提供商: ${settings.provider}，使用本地匹配`);
    return localKeywordMatch(pageInfo, folders);
  }

  const prompt = buildPrompt(pageInfo, folders);

  try {
    const rawResponse = await callProviderAPI(prompt, providerInfo, settings.model, settings.apiKey);
    return parseClassification(rawResponse, folders);
  } catch (error) {
    console.warn('[智能收藏夹] AI API 调用失败，降级为本地匹配:', error.message);
    return localKeywordMatch(pageInfo, folders);
  }
}

export { classify, getUserSettings };
