/**
 * 智能收藏夹 - Content Script
 * 职责：拦截 Ctrl+D、提取页面信息、注入弹窗、与 Service Worker 通信
 */

// ========== 防抖 ==========
let lastTriggerTime = 0;
const DEBOUNCE_MS = 300;

// ========== 页面信息提取 ==========

function extractPageInfo() {
  const title = document.title || '';
  const url = window.location.href;

  // 尝试多个来源获取描述
  let description = '';
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    description = metaDesc.getAttribute('content') || '';
  }
  if (!description) {
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) {
      description = ogDesc.getAttribute('content') || '';
    }
  }

  // 提取 Open Graph 标题（可能比 document.title 更好）
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const bestTitle = ogTitle ? ogTitle.getAttribute('content') || title : title;

  return { title: bestTitle, url, description };
}

// ========== 键盘拦截 ==========

function isEditable(el) {
  const tag = el.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const isContentEditable = el.isContentEditable;
  return isInput || isContentEditable;
}

document.addEventListener('keydown', async (event) => {
  const isCtrlD = (event.ctrlKey || event.metaKey) && event.key === 'd';

  if (!isCtrlD) return;

  // 如果焦点在输入框中，不拦截（用户可能正在文本编辑）
  if (isEditable(event.target)) return;

  // 防抖
  const now = Date.now();
  if (now - lastTriggerTime < DEBOUNCE_MS) return;
  lastTriggerTime = now;

  event.preventDefault();
  event.stopPropagation();

  try {
    await triggerBookmarkFlow();
  } catch (err) {
    console.warn('[智能收藏夹] 收藏流程异常:', err.message);
    showToast('操作失败，请刷新页面后重试');
  }
});

// ========== 收藏流程 ==========

async function triggerBookmarkFlow() {
  const pageInfo = extractPageInfo();

  // 跳过特殊页面
  if (!pageInfo.url ||
      pageInfo.url.startsWith('chrome://') ||
      pageInfo.url.startsWith('chrome-extension://') ||
      pageInfo.url.startsWith('about:')) {
    return;
  }

  // 检查扩展上下文是否有效（避免「Extension context invalidated」）
  if (!isExtensionValid()) {
    showToast('扩展已更新或重新加载，请刷新页面后重试');
    return;
  }

  // 发起 AI 分类请求（作为 Promise 传给 Dialog，弹窗立即显示 loading）
  const classificationPromise = chrome.runtime.sendMessage({
    type: 'CLASSIFY',
    payload: pageInfo
  }).then(cls => {
    if (!cls) throw new Error('通信失败');
    if (cls.type === 'ALREADY_BOOKMARKED') {
      return { __bookmarked: true, folder: cls.existingFolder, title: cls.existingTitle, bookmarkId: cls.bookmarkId, folderTree: [] };
    }
    // 将 folderTree 附带到 result 上
    cls.result.folderTree = cls.folderTree || [];
    return cls.result;
  });

  // 立即弹出 loading 弹窗，Promise resolve 后自动更新
  const result = await Dialog.show(pageInfo, classificationPromise);

  if (result.action === 'cancel') return;

  if (result.action === 'remove') {
    try {
      await chrome.runtime.sendMessage({
        type: 'REMOVE_BOOKMARK',
        payload: { bookmarkId: result.bookmarkId }
      });
      showToast('已从收藏夹中移除');
    } catch (err) {
      console.warn('[智能收藏夹] 移除书签失败:', err);
    }
    return;
  }

  // 用户确认，创建书签
  const payload = {
    title: result.title,
    url: result.url,
    folderId: result.folderId,
    folderName: result.folderName,
    newFolder: result.newFolder,
    newFolderName: result.newFolderName
  };

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CREATE_BOOKMARK',
      payload
    });

    if (response?.type === 'BOOKMARK_CREATED') {
      showToast(`已收藏到「${response.folderName}」`);
    }
  } catch (err) {
    console.error('[智能收藏夹] 创建书签失败:', err);
    showToast('收藏失败，请重试');
  }
}

// ========== 已收藏提示 ==========

function showAlreadyBookmarkedDialog(classification, pageInfo) {
  // 简单的确认弹窗
  const overlay = document.createElement('div');
  overlay.className = 'smart-bookmark-overlay';
  overlay.innerHTML = `
    <div class="smart-bookmark-dialog" style="text-align:center;">
      <div class="sb-header" style="justify-content:center;">
        <div class="sb-header-icon">
          <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:#fff;"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>
        </div>
        <div class="sb-header-text">
          <div class="sb-header-title">已收藏过此页面</div>
          <div class="sb-header-subtitle">存放在「${escapeHtml(classification.existingFolder)}」</div>
        </div>
      </div>
      <div class="sb-footer" style="justify-content:center;border-top:none;padding-top:8px;">
        <button class="sb-btn sb-btn-cancel js-close">知道了</button>
      </div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('js-close')) {
      overlay.remove();
    }
  });

  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }
  });

  document.body.appendChild(overlay);
}

// ========== Toast 提示 ==========

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: #1d1d1f;
    color: #fff;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    z-index: 2147483647;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    animation: sb-toast-in 0.3s ease-out;
  `;

  // 注入动画
  const style = document.createElement('style');
  style.textContent = `
    @keyframes sb-toast-in {
      from { opacity: 0; transform: translateX(-50%) translateY(10px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => {
      toast.remove();
      style.remove();
    }, 300);
  }, 2500);
}

// ========== 重新分类（从通知触发） ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PAGE_TITLE') {
    sendResponse({ title: document.title || '' });
    return;
  }

  if (message.type === 'TRIGGER_BOOKMARK') {
    triggerBookmarkFlow().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'SHOW_RECLASSIFY_DIALOG') {
    // 星标按钮场景：重新分类已有的书签
    handleReclassify(message.payload).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handleReclassify(payload) {
  const pageInfo = extractPageInfo();

  const classification = await chrome.runtime.sendMessage({
    type: 'CLASSIFY',
    payload: { title: payload.title, url: payload.url, description: pageInfo.description }
  });

  if (!classification || classification.type !== 'CLASSIFY_RESULT') return;

  // 复用 Dialog 显示
  const result = await Dialog.show(
    { title: payload.title, url: payload.url, description: pageInfo.description },
    classification.result
  );

  if (result.action === 'cancel') return;

  try {
    // 移动书签到新位置
    let targetFolderId = result.folderId;
    if (result.newFolder && result.newFolderName) {
      const newFolder = await chrome.runtime.sendMessage({
        type: 'CREATE_FOLDER',
        payload: { name: result.newFolderName }
      });
      targetFolderId = newFolder?.id;
    }

    if (targetFolderId) {
      await chrome.bookmarks.move(payload.bookmarkId, { parentId: targetFolderId });
      showToast('书签已移动');
    }
  } catch (err) {
    console.error('[智能收藏夹] 移动书签失败:', err);
    showToast('操作失败');
  }
}

// ========== 工具函数 ==========

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function isExtensionValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}
