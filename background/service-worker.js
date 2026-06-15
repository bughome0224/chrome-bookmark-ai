/**
 * 智能收藏夹 - Service Worker
 * 核心调度：文件夹获取、AI 分类、书签 CRUD、星标按钮监听
 */

import { classify } from '../utils/classifier.js';

// 文件夹列表缓存
let folderCache = { data: null, timestamp: 0, ttl: 30000 };

/**
 * 获取所有书签文件夹（扁平化，含缓存）
 */
async function getFolders() {
  const now = Date.now();
  if (folderCache.data && (now - folderCache.timestamp) < folderCache.ttl) {
    return folderCache.data;
  }

  const tree = await chrome.bookmarks.getTree();
  const folders = [];
  const stack = [...tree];

  while (stack.length) {
    const node = stack.pop();
    if (node.children) {
      for (const child of node.children) {
        if (child.children) {
          // 有 children 的是文件夹
          folders.push({ id: child.id, title: child.title, parentId: child.parentId });
          stack.push(child);
        }
      }
    }
  }

  folderCache = { data: folders, timestamp: now, ttl: 30000 };
  return folders;
}

/**
 * 获取完整文件夹树结构（含层级信息，供弹窗展示目录选择器）
 */
async function getFolderTree() {
  const tree = await chrome.bookmarks.getTree();
  const buildTree = (nodes, depth) => {
    const result = [];
    for (const node of nodes) {
      if (node.children) {
        result.push({ id: node.id, title: node.title, depth, parentId: node.parentId });
        result.push(...buildTree(node.children, depth + 1));
      }
    }
    return result;
  };
  // 跳过根节点，仅返回书签栏及其子树
  const root = tree[0];
  if (!root?.children) return [];
  return buildTree(root.children, 0);
}

/**
 * 清除文件夹缓存
 */
function clearFolderCache() {
  folderCache = { data: null, timestamp: 0, ttl: 30000 };
}

/**
 * 获取书签栏文件夹 ID（动态解析，不硬编码 '1'）
 */
async function getBookmarksBarId() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  if (!root?.children?.length) return '1';
  // 书签栏始终是根节点的第一个子节点
  return root.children[0].id;
}

/**
 * 提取页面描述信息
 */
function extractPageInfo(payload) {
  return {
    title: payload.title || '',
    url: payload.url || '',
    description: payload.description || ''
  };
}

/**
 * 检查页面的书签是否已存在，返回已存在的书签节点
 */
async function findExistingBookmark(url) {
  const results = await chrome.bookmarks.search({ url });
  return results.length > 0 ? results[0] : null;
}

/**
 * 获取书签所在的文件夹路径
 */
async function getFolderPath(bookmarkNode) {
  if (!bookmarkNode.parentId) return '根目录';
  const parents = [];
  let currentId = bookmarkNode.parentId;

  while (currentId) {
    try {
      const [node] = await chrome.bookmarks.get(currentId);
      if (!node || !node.parentId) break;
      parents.unshift(node.title);
      currentId = node.parentId;
    } catch {
      break;
    }
  }

  return parents.length > 0 ? parents.join(' > ') : '根目录';
}

/**
 * 处理分类请求（来自 content script 或 popup）
 */
async function handleClassify(payload) {
  const pageInfo = extractPageInfo(payload);

  // 检查是否已收藏
  const existing = await findExistingBookmark(pageInfo.url);
  if (existing) {
    const folderPath = await getFolderPath(existing);
    return {
      type: 'ALREADY_BOOKMARKED',
      existingFolder: folderPath,
      existingTitle: existing.title,
      bookmarkId: existing.id,
      pageInfo
    };
  }

  // 获取文件夹列表并分类
  const folders = await getFolders();
  const folderTree = await getFolderTree();
  const result = await classify(pageInfo, folders);

  return {
    type: 'CLASSIFY_RESULT',
    pageInfo,
    result,
    folderTree
  };
}

/**
 * 处理书签创建请求（来自 content script 确认后）
 */
async function handleCreateBookmark(data) {
  let parentId = null;
  const folders = await getFolders();
  if (data.newFolder && data.newFolderName) {
    // 用户明确选择新建文件夹
    parentId = await ensureFolder(data.newFolderName, folders);
    clearFolderCache();
  } else {
    // 尝试匹配已有文件夹
    parentId = resolveFolderId(data, folders);

    // 兜底：有名称但匹配不到任何文件夹 → 自动新建
    if (!parentId) {
      const fallbackName = data.folderName || data.newFolderName;
      if (fallbackName) {
        parentId = await ensureFolder(fallbackName, folders);
        clearFolderCache();
      }
    }
  }
  const bookmark = await chrome.bookmarks.create({
    parentId: parentId || undefined,
    title: data.title,
    url: data.url
  });

  clearFolderCache();

  const folderName = parentId
    ? (await chrome.bookmarks.get(parentId))[0]?.title || '其他书签'
    : '其他书签';

  return { type: 'BOOKMARK_CREATED', bookmark, folderName };
}

/**
 * 确保文件夹存在：不存在则创建，重名则追加编号
 */
async function ensureFolder(name, folders) {
  const exact = folders.find(f => f.title === name);
  if (exact) return exact.id;

  const existingNames = new Set(folders.map(f => f.title));
  let finalName = name;
  if (existingNames.has(finalName)) {
    let counter = 2;
    while (existingNames.has(`${finalName} (${counter})`)) counter++;
    finalName = `${finalName} (${counter})`;
  }
  // 在书签栏中创建，而非其他书签
  const barId = await getBookmarksBarId();
  const created = await chrome.bookmarks.create({ parentId: barId, title: finalName });
  return created.id;
}

/**
 * 根据 folderId / folderName 匹配文件夹
 */
function resolveFolderId(data, folders) {
  // 优先按 Chrome 文件夹 ID 匹配
  if (data.folderId) {
    const byId = folders.find(f => f.id === data.folderId);
    if (byId) return byId.id;
  }

  // 按 AI 返回的文件夹名称匹配（精确匹配）
  if (data.folderName) {
    const byName = folders.find(f => f.title === data.folderName);
    if (byName) return byName.id;
  }

  // folderId 可能是名称而非 ID（AI 匹配失败时的兜底）
  if (data.folderId) {
    const byName2 = folders.find(f => f.title === data.folderId);
    if (byName2) return byName2.id;
  }

  // 宽松匹配：包含关系
  if (data.folderName) {
    const fuzzy = folders.find(f =>
      f.title.includes(data.folderName) || data.folderName.includes(f.title)
    );
    if (fuzzy) return fuzzy.id;
  }

  return null;
}

// ========== 消息监听 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CLASSIFY':
      handleClassify(message.payload).then(sendResponse);
      return true; // 异步响应

    case 'CREATE_BOOKMARK':
      handleCreateBookmark(message.payload).then(sendResponse);
      return true;

    case 'CLASSIFY_FROM_POPUP':
      // 从 popup 触发的分类，返回结果后由 popup 处理
      handleClassify(message.payload).then(sendResponse);
      return true;

    case 'REMOVE_BOOKMARK':
      chrome.bookmarks.remove(message.payload.bookmarkId).then(() => {
        sendResponse({ ok: true });
      }).catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
      return true;

    case 'CREATE_FOLDER':
      // 创建新文件夹并返回其 ID
      (async () => {
        const folders = await getFolders();
        let folderName = message.payload.name;
        const existingNames = new Set(folders.map(f => f.title));
        if (existingNames.has(folderName)) {
          let counter = 2;
          while (existingNames.has(`${folderName} (${counter})`)) counter++;
          folderName = `${folderName} (${counter})`;
        }
        const barId = await getBookmarksBarId();
        const newFolder = await chrome.bookmarks.create({ parentId: barId, title: folderName });
        clearFolderCache();
        sendResponse({ id: newFolder.id, title: newFolder.title });
      })();
      return true;

    case 'GET_PAGE_INFO':
      getCurrentTabInfo().then(sendResponse);
      return true;
  }
});

/**
 * 获取当前活动标签页信息
 */
async function getCurrentTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return { title: tab.title, url: tab.url };
}

// ========== 星标按钮监听 ==========

let lastAutoBookmark = { url: '', timestamp: 0 };

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  // 忽略我们自己在 service worker 中创建的书签（扩展创建的）
  // 也忽略文件夹
  if (!bookmark.url) return;

  // 防抖：忽略刚由扩展弹窗创建的书签
  if (bookmark.url === lastAutoBookmark.url &&
      Date.now() - lastAutoBookmark.timestamp < 2000) {
    return;
  }

  // 检查是否在根目录或"其他书签"下（用户通过星标按钮添加的默认行为）
  const rootFolders = ['0', '1', '2']; // 根节点 ID
  const PARENT_OTHER_BOOKMARKS = '2'; // 其他书签

  if (!rootFolders.includes(bookmark.parentId) && bookmark.parentId !== PARENT_OTHER_BOOKMARKS) {
    // 用户已经选了文件夹，不干预
    return;
  }

  // 检查是否刚通过扩展弹窗创建
  const recent = await chrome.storage.local.get('lastCreatedAt');
  if (recent.lastCreatedAt && Date.now() - recent.lastCreatedAt < 3000) {
    return;
  }

  // 弹出通知，提示用户可以重新分类
  const notificationId = `reclassify-${id}`;
  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: '智能收藏夹',
      message: `已将 "${bookmark.title}" 添加到书签，点击这里为它找到最合适的文件夹`,
      priority: 1
    });

    // 暂存待处理的书签信息
    await chrome.storage.local.set({
      pendingReclassify: { id, title: bookmark.title, url: bookmark.url }
    });
  } catch {
    // 通知创建失败（如无权限），忽略
  }
});

// 点击通知 → 触发重新分类
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('reclassify-')) return;

  const { pendingReclassify } = await chrome.storage.local.get('pendingReclassify');
  if (!pendingReclassify) return;

  // 获取当前活动标签页，发送消息触发弹窗
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_RECLASSIFY_DIALOG',
      payload: {
        title: pendingReclassify.title,
        url: pendingReclassify.url,
        bookmarkId: pendingReclassify.id
      }
    }).catch(() => {});
  }

  chrome.notifications.clear(notificationId);
  await chrome.storage.local.remove('pendingReclassify');
});

// ========== 跨扩展消息（用于 options 页通知 API key 变更） ==========

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.apiKey) {
    // API Key 变更时清除缓存
    clearFolderCache();
  }
});
