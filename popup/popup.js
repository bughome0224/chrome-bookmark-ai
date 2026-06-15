/**
 * 智能收藏夹 - 扩展弹窗逻辑
 */

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageEl = document.querySelector('.js-current-page');
  const smartBtn = document.querySelector('.js-smart-bookmark');
  const noApiHint = document.querySelector('.js-no-api-hint');

  // 检查 API Key：优先读 local（即时生效），fallback 到 sync
  const local = await chrome.storage.local.get('apiKey');
  const sync = await chrome.storage.sync.get('apiKey');
  const apiKey = local.apiKey || sync.apiKey;

  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    // 优先从 content script 获取实时标题（tab.title 在页面切换后可能滞后）
    let pageTitle = tab.title || '无标题';
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_TITLE' });
      if (resp?.title) pageTitle = resp.title;
    } catch {
      // content script 不可用，使用 tab.title 兜底
    }

    pageEl.innerHTML = `
      <div class="page-title">${escapeHtml(pageTitle)}</div>
      <div class="page-url">${escapeHtml(tab.url)}</div>
    `;
  } else {
    pageEl.innerHTML = '<div class="page-loading">当前页面不可收藏</div>';
    smartBtn.disabled = true;
  }

  // 未配置 API Key → 禁用按钮
  if (!apiKey) {
    smartBtn.disabled = true;
    noApiHint.classList.remove('hidden');
  }

  // 加载最近收藏
  loadRecentBookmarks();

  // 智能收藏按钮
  smartBtn.addEventListener('click', async () => {
    if (!apiKey) return;
    if (!tab?.url || tab.url.startsWith('chrome://')) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_BOOKMARK' });
      window.close();
    } catch {
      // content script 不可用（扩展刚更新/页面未完全加载）
      smartBtn.disabled = true;
      smartBtn.textContent = '请刷新页面后重试';
      setTimeout(() => {
        smartBtn.disabled = false;
        smartBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
            <polyline points="12 8 12 15"/>
            <polyline points="9 11 12 8 15 11"/>
          </svg>
          智能收藏此页面
        `;
      }, 2000);
    }
  });

  // 设置链接
  document.querySelector('.js-open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.querySelector('.js-open-options-inline').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.querySelector('.js-open-bookmarks').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://bookmarks/' });
  });
});

async function loadRecentBookmarks() {
  const listEl = document.querySelector('.js-recent-list');

  try {
    const tree = await chrome.bookmarks.getRecent(5);
    if (tree.length === 0) {
      listEl.innerHTML = '<li class="recent-empty">暂无收藏记录</li>';
      return;
    }

    listEl.innerHTML = tree.map(bm => `
      <li class="recent-item" title="${escapeHtml(bm.url || '')}">
        <span class="recent-item-icon">📄</span>
        <div class="recent-item-info">
          <div class="recent-item-title">${escapeHtml(bm.title)}</div>
          <div class="recent-item-folder">${bm.dateAdded ? formatTime(bm.dateAdded) : ''}</div>
        </div>
      </li>
    `).join('');
  } catch {
    listEl.innerHTML = '<li class="recent-empty">加载失败</li>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;

  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;

  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
