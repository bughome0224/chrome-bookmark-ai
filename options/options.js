/**
 * 智能收藏夹 - 设置页面逻辑
 * 从 config.json 读取默认配置，支持从 API 刷新最新模型并缓存到 chrome.storage.local
 */

const CACHE_KEY = 'modelCache';
const CACHE_TTL = 24 * 60 * 60 * 1000;

let providerConfig = null;
let modelCache = {};

document.addEventListener('DOMContentLoaded', async () => {
  const providerSelect = document.getElementById('provider');
  const modelSelect = document.getElementById('model');
  const apiKeyInput = document.getElementById('apiKey');
  const refreshBtn = document.querySelector('.js-refresh-models');
  const modelHint = document.querySelector('.js-model-hint');
  const saveBtn = document.querySelector('.js-save');
  const statusEl = document.querySelector('.js-status');

  // 加载配置和缓存
  providerConfig = await loadConfig();
  modelCache = await loadCache();

  const stored = await chrome.storage.sync.get(['provider', 'model', 'apiKey']);

  // 渲染提供商
  providerSelect.innerHTML = providerConfig.providers.map(p =>
    `<option value="${p.id}">${p.name}</option>`
  ).join('');

  const currentProvider = stored.provider || providerConfig.providers[0].id;
  providerSelect.value = currentProvider;
  apiKeyInput.value = stored.apiKey || '';

  // 渲染模型 + 恢复选择
  renderModels(currentProvider);
  const savedModel = stored.model || getDefaultModel(currentProvider);
  if (Array.from(modelSelect.options).some(o => o.value === savedModel)) {
    modelSelect.value = savedModel;
  }
  updateModelHint(currentProvider);

  // ---- 事件 ----

  providerSelect.addEventListener('change', () => {
    const pid = providerSelect.value;
    renderModels(pid);
    updateModelHint(pid);
  });

  refreshBtn.addEventListener('click', () => onRefreshModels());

  saveBtn.addEventListener('click', async () => {
    const config = {
      provider: providerSelect.value,
      model: modelSelect.value,
      apiKey: apiKeyInput.value.trim()
    };
    try {
      await chrome.storage.sync.set(config);
      // 同时写入 local，确保 popup 能立即读取（sync 可能有延迟）
      await chrome.storage.local.set(config);
      showStatus('设置已保存', 'success');
    } catch (err) {
      showStatus('保存失败: ' + err.message, 'error');
    }
  });

  // ---- 函数 ----

  function getProvider(pid) {
    return providerConfig.providers.find(p => p.id === pid);
  }

  function getDefaultModel(pid) {
    const p = getProvider(pid);
    return p?.models?.[0]?.id || '';
  }

  function renderModels(pid) {
    const defaults = getProvider(pid)?.models || [];
    const cached = modelCache[pid];
    const defaultIds = new Set(defaults.map(m => m.id));
    const merged = [...defaults];

    if (cached?.models?.length) {
      for (const m of cached.models) {
        if (defaultIds.has(m.id)) {
          merged.push({ id: m.id, name: m.name + '（官网）' });
        } else {
          merged.push(m);
        }
      }
    }

    modelSelect.innerHTML = merged.map(m =>
      `<option value="${m.id}">${m.name}</option>`
    ).join('');
  }

  function updateModelHint(pid) {
    const cached = modelCache[pid];
    if (cached) {
      const date = new Date(cached.updatedAt).toLocaleString('zh-CN');
      modelHint.textContent = `已从官网拉取 ${cached.models.length} 个模型，同名模型标记为「官网」`;
    } else {
      modelHint.textContent = '点击刷新按钮，从官网拉取最新模型列表。';
    }
  }

  // ---- 刷新模型 ----

  async function onRefreshModels() {
    const provider = getProvider(providerSelect.value);

    if (!provider.modelsEndpoint) {
      showStatus(`「${provider.name}」不支持在线拉取模型列表`, 'error');
      return;
    }

    refreshBtn.classList.add('loading');
    refreshBtn.disabled = true;
    showStatus('正在拉取模型列表...', '');

    const apiKey = apiKeyInput.value.trim();

    try {
      const models = await fetchModelsFromProvider(provider, apiKey);
      if (models.length > 0) {
        modelCache[provider.id] = { models, updatedAt: Date.now() };
        await chrome.storage.local.set({ [CACHE_KEY]: modelCache });

        refreshBtn.classList.add('success');
        setTimeout(() => refreshBtn.classList.remove('success'), 2000);
        showStatus(`成功拉取 ${models.length} 个模型`, 'success');
      } else {
        refreshBtn.classList.add('error');
        setTimeout(() => refreshBtn.classList.remove('error'), 2000);
        showStatus('未获取到可用模型', 'error');
      }
    } catch (err) {
      console.warn(`[智能收藏夹] 获取模型失败:`, err.message);
      refreshBtn.classList.add('error');
      setTimeout(() => refreshBtn.classList.remove('error'), 2000);
      showStatus(`拉取失败: ${err.message}`, 'error');
    }

    refreshBtn.classList.remove('loading');
    refreshBtn.disabled = false;

    renderModels(providerSelect.value);
    updateModelHint(providerSelect.value);
  }

  function showStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'save-status ' + (type || '');
    if (type) {
      setTimeout(() => {
        if (statusEl.textContent === msg) {
          statusEl.textContent = '';
          statusEl.className = 'save-status';
        }
      }, 3000);
    }
  }
});

// ====== 缓存 ======

async function loadCache() {
  const result = await chrome.storage.local.get(CACHE_KEY);
  const cache = result[CACHE_KEY] || {};
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of Object.entries(cache)) {
    if (now - entry.updatedAt > CACHE_TTL) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  }
  return cache;
}

// ====== API 拉取 ======

async function fetchModelsFromProvider(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(provider.modelsEndpoint, {
    headers,
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.data && Array.isArray(data.data)) {
    return parseModelList(data.data);
  }

  return [];
}

function parseModelList(modelList) {
  const chatPrefixes = ['gpt-', 'o1', 'o2', 'o3', 'o4', 'deepseek-'];
  const exclude = ['audio', 'tts', 'whisper', 'embedding', 'dall-e', 'davinci',
    'babbage', 'inference', 'ft:', 'realtime', 'draft'];

  const chatModels = modelList.filter(m => {
    const id = m.id.toLowerCase();
    if (exclude.some(p => id.includes(p))) return false;
    return chatPrefixes.some(p => id.startsWith(p));
  });

  chatModels.sort((a, b) => (b.created || 0) - (a.created || 0));

  const seen = new Set();
  const deduped = [];
  for (const m of chatModels) {
    const key = m.id.replace(/-latest|-preview|-\d{4}-\d{2}-\d{2}/g, '');
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push({ id: m.id, name: formatModelName(m.id) });
    }
  }

  return deduped.slice(0, 20);
}

function formatModelName(id) {
  return id
    .replace(/^deepseek-/, 'DeepSeek ')
    .replace(/^gpt-4o/, 'GPT-4o')
    .replace(/^gpt-4\.?/, 'GPT-4 ')
    .replace(/^gpt-3\.?5/, 'GPT-3.5')
    .replace(/^o1/, 'o1')
    .replace(/^o2/, 'o2')
    .replace(/^o3/, 'o3')
    .replace(/^o4/, 'o4')
    .replace(/-/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function loadConfig() {
  const url = chrome.runtime.getURL('config.json');
  const res = await fetch(url);
  return res.json();
}
