/**
 * 智能收藏弹窗交互逻辑
 * 支持传入 Promise：立即弹出 loading，AI 返回后自动切换为结果
 */

const Dialog = {
  _resolve: null,
  _overlay: null,
  _selectedFolderId: null,
  _selectedFolderName: null,
  _selectedNewFolder: false,
  _pageInfo: null,
  _bookmarkedData: null,
  _scrollY: 0,

  /**
   * 显示收藏弹窗
   * @param {Object} pageInfo - { title, url, description }
   * @param {Object|Promise} resultOrPromise - AI 分类结果，或 resolve 为该结果的 Promise
   * @returns {Promise<Object>} 用户选择结果
   */
  show(pageInfo, resultOrPromise) {
    this._remove();
    this._lockScroll();
    this._pageInfo = pageInfo;

    const isPromise = resultOrPromise && typeof resultOrPromise.then === 'function';

    if (isPromise) {
      // 先显示 loading 状态
      this._overlay = this._buildShell(pageInfo, true);
      document.body.appendChild(this._overlay);
      this._bindShellEvents();

      // 等待结果后更新
      resultOrPromise
        .then(result => {
          if (!this._overlay) return; // 用户已取消
          this._updateResult(result);
        })
        .catch(err => {
          if (!this._overlay) return;
          this._showError(err.message);
        });
    } else {
      this._overlay = this._buildFull(pageInfo, resultOrPromise);
      document.body.appendChild(this._overlay);
      this._bindEvents(resultOrPromise);
    }

    return new Promise(resolve => {
      this._resolve = resolve;
    });
  },

  _remove() {
    this._unlockScroll();
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
  },

  _lockScroll() {
    this._scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${this._scrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflowY = 'scroll';
  },

  _unlockScroll() {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    document.body.style.overflowY = '';
    window.scrollTo(0, this._scrollY);
  },

  // ---- 外壳（标题 + URL，不含结果区） ----

  _buildShell(pageInfo, loading) {
    const overlay = document.createElement('div');
    overlay.className = 'smart-bookmark-overlay';
    overlay.innerHTML = `
      <div class="smart-bookmark-dialog" role="dialog" aria-label="智能收藏">
        <div class="sb-header">
          <div class="sb-header-icon">
            <svg viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15l-5-2.18L7 18V5h10v13z"/></svg>
          </div>
          <div class="sb-header-text">
            <div class="sb-header-title">智能收藏</div>
            <div class="sb-header-subtitle">AI 分析页面内容，推荐最合适的存放位置</div>
          </div>
        </div>

        <div class="sb-field">
          <label class="sb-label">标题</label>
          <input class="sb-input js-title-input" type="text" value="${this._esc(pageInfo.title)}" placeholder="书签标题">
        </div>

        <div class="sb-field">
          <label class="sb-label">链接</label>
          <div class="sb-url-display">${this._esc(pageInfo.url)}</div>
        </div>

        <div class="sb-section-title js-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          推荐存放位置
        </div>

        <div class="js-result-area">
          ${loading ? `
            <div class="sb-loading">
              <div class="sb-spinner"></div>
              <span>AI 正在分析页面内容…</span>
            </div>
          ` : ''}
        </div>

        <div class="sb-footer">
          <button class="sb-btn sb-btn-cancel js-cancel">取消</button>
          <button class="sb-btn sb-btn-confirm js-confirm" disabled>确认收藏</button>
        </div>
      </div>
    `;
    return overlay;
  },

  _bindShellEvents() {
    const overlay = this._overlay;
    const dialog = overlay.querySelector('.smart-bookmark-dialog');
    const titleInput = overlay.querySelector('.js-title-input');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._cancel();
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escHandler);
        this._cancel();
      }
    };
    document.addEventListener('keydown', escHandler);

    dialog.addEventListener('click', (e) => e.stopPropagation());
    overlay.querySelector('.js-cancel').addEventListener('click', () => this._cancel());

    titleInput.focus();
    titleInput.select();
  },

  // ---- 完整构建（已有结果时） ----

  _buildFull(pageInfo, result) {
    const overlay = this._buildShell(pageInfo, false);
    const resultArea = overlay.querySelector('.js-result-area');
    resultArea.innerHTML = this._buildResultHTML(result) + this._buildFolderTreeHTML(result.folderTree || []);
    return overlay;
  },

  // ---- 更新结果（Promise resolve 后调用） ----

  _updateResult(result) {
    const overlay = this._overlay;
    const resultArea = overlay.querySelector('.js-result-area');

    if (result && result.__bookmarked) {
      overlay.querySelector('.js-section-title')?.remove();
      this._bookmarkedData = { bookmarkId: result.bookmarkId, folder: result.folder };
      resultArea.innerHTML = `
        <div style="text-align:center;padding:12px 0;color:#6e6e73;font-size:13px;">
          此页面已收藏在<br><strong style="color:#f5f5f7;font-size:14px;">${this._esc(result.folder)}</strong>
        </div>
      `;
      // 取消按钮 → 替换为「移除」（清除旧监听器）
      const cancelBtn = overlay.querySelector('.js-cancel');
      const removeBtn = cancelBtn.cloneNode(true);
      removeBtn.textContent = '移除';
      removeBtn.classList.add('sb-btn-remove');
      cancelBtn.replaceWith(removeBtn);
      removeBtn.addEventListener('click', () => this._removeBookmark());

      const confirmBtn = overlay.querySelector('.js-confirm');
      const knownBtn = confirmBtn.cloneNode(true);
      knownBtn.textContent = '知道了';
      knownBtn.disabled = false;
      confirmBtn.replaceWith(knownBtn);
      knownBtn.addEventListener('click', () => this._cancel());
      return;
    }

    resultArea.innerHTML = this._buildResultHTML(result) + this._buildFolderTreeHTML(result.folderTree || []);

    const confirmBtn = overlay.querySelector('.js-confirm');
    confirmBtn.disabled = false;

    this._bindEvents(result);
  },

  _buildFolderTreeHTML(tree) {
    if (!tree.length) return '';

    const items = tree.map(f => {
      const indentPx = f.depth * 18;
      const isRoot = f.depth === 0;
      const lines = [];
      if (f.depth > 0) {
        for (let d = 0; d < f.depth; d++) {
          lines.push(`<span class="sb-tree-line" style="left:${d * 18 + 2}px"></span>`);
        }
      }
      return `
        <div class="sb-tree-item" data-folder-id="${this._esc(f.id)}" data-folder-name="${this._esc(f.title)}" data-folder-depth="${f.depth}" style="padding-left:${indentPx + 28}px">
          ${lines.join('')}
          <span class="sb-tree-connector" style="left:${indentPx + 14}px"></span>
          <span class="sb-tree-icon">${isRoot ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.89l-1.1-1.66A2 2 0 0 0 7.65 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg>'}</span>
          <span class="sb-tree-name">${this._esc(f.title)}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="sb-folder-tree-section">
        <div class="sb-section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          或选择已有收藏夹
        </div>
        <div class="sb-tree-search">
          <svg class="sb-tree-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="js-tree-search-input" type="text" placeholder="搜索收藏夹…">
        </div>
        <div class="sb-tree-scroll js-tree-scroll">
          ${items}
        </div>
      </div>
    `;
  },

  _showError(msg) {
    const overlay = this._overlay;
    const resultArea = overlay.querySelector('.js-result-area');
    resultArea.innerHTML = `<div class="sb-error">AI 分类失败：${this._esc(msg)}<br>请检查网络或 API Key 配置</div>`;
  },

  // ---- 结果 HTML ----

  _buildResultHTML(result) {
    const { matchType, suggestions, newFolderSuggestion } = result;
    const folderOptions = this._buildFolderOptions(suggestions, matchType);
    const noMatchHint = matchType === 'new' && !newFolderSuggestion
      ? '<div class="sb-no-match">未找到匹配的文件夹，建议新建一个</div>'
      : '';
    const newFolderSelected = matchType === 'new' ? 'selected' : '';

    return `
      <ul class="sb-folder-list js-folder-list">${folderOptions}</ul>
      ${noMatchHint}
      <div class="sb-new-folder js-new-folder ${newFolderSelected}">
        <span class="sb-new-folder-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        </span>
        <input class="sb-new-folder-input js-new-folder-input"
               type="text"
               placeholder="新建文件夹名称..."
               value="${this._esc(newFolderSuggestion || '')}">
      </div>
    `;
  },

  _buildFolderOptions(suggestions, matchType) {
    if (!suggestions.length) return '';

    return suggestions.map((s, i) => {
      const confidenceClass = s.confidence >= 0.7 ? 'sb-confidence-high'
        : s.confidence >= 0.4 ? 'sb-confidence-mid'
        : 'sb-confidence-low';
      const selected = i === 0 && matchType !== 'new' ? 'selected' : '';

      return `
        <li class="sb-folder-option js-folder-option ${selected}"
            data-folder-id="${this._esc(s.folderId || '')}"
            data-folder-name="${this._esc(s.folderName)}">
          <div class="sb-folder-radio"></div>
          <div class="sb-folder-info">
            <div>
              <div class="sb-folder-name">${this._esc(s.folderName)}</div>
              ${s.reason ? `<div class="sb-folder-reason">${this._esc(s.reason)}</div>` : ''}
            </div>
            <span class="sb-folder-confidence ${confidenceClass}">${Math.round(s.confidence * 100)}%</span>
          </div>
        </li>
      `;
    }).join('');
  },

  // ---- 事件绑定 ----

  _bindEvents(result) {
    const overlay = this._overlay;
    const titleInput = overlay.querySelector('.js-title-input');
    const confirmBtn = overlay.querySelector('.js-confirm');
    const newFolderDiv = overlay.querySelector('.js-new-folder');
    const newFolderInput = overlay.querySelector('.js-new-folder-input');
    const folderOptions = overlay.querySelectorAll('.js-folder-option');

    const { matchType, suggestions } = result;

    this._selectedFolderId = null;
    this._selectedFolderName = null;
    this._selectedNewFolder = matchType === 'new';

    if (matchType !== 'new' && suggestions.length > 0) {
      this._selectedFolderId = suggestions[0].folderId || '';
      this._selectedFolderName = suggestions[0].folderName || '';
    }

    // 选择已有文件夹
    folderOptions.forEach(opt => {
      opt.addEventListener('click', () => {
        folderOptions.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        newFolderDiv.classList.remove('selected');
        this._selectedFolderId = opt.dataset.folderId;
        this._selectedFolderName = opt.dataset.folderName;
        this._selectedNewFolder = false;
      });
    });

    // 选择新建文件夹
    newFolderDiv.addEventListener('click', (e) => {
      if (e.target === newFolderInput) return;
      folderOptions.forEach(o => o.classList.remove('selected'));
      newFolderDiv.classList.add('selected');
      this._selectedNewFolder = true;
      newFolderInput.focus();
    });

    newFolderInput.addEventListener('click', (e) => {
      e.stopPropagation();
      folderOptions.forEach(o => o.classList.remove('selected'));
      newFolderDiv.classList.add('selected');
      this._selectedNewFolder = true;
    });

    newFolderInput.addEventListener('input', () => {
      newFolderInput.classList.remove('sb-input-error');
    });

    newFolderInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === newFolderInput) {
        this._confirm(titleInput);
      }
    });

    // 文件夹树选择器 → 选中该文件夹并取消 AI 推荐和新建
    const treeItems = overlay.querySelectorAll('.sb-tree-item');
    treeItems.forEach(item => {
      item.addEventListener('click', () => {
        treeItems.forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        folderOptions.forEach(o => o.classList.remove('selected'));
        newFolderDiv?.classList.remove('selected');
        this._selectedFolderId = item.dataset.folderId;
        this._selectedFolderName = item.dataset.folderName;
        this._selectedNewFolder = false;
      });
    });

    // 搜索过滤（含上级目录）
    const searchInput = overlay.querySelector('.js-tree-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        const scroll = overlay.querySelector('.js-tree-scroll');
        const allItems = [...scroll.querySelectorAll('.sb-tree-item')];

        // 标出所有匹配项
        const matchSet = new Set();
        allItems.forEach(item => {
          const name = (item.dataset.folderName || '').toLowerCase();
          if (name.includes(query)) matchSet.add(item);
        });

        // 向父级追溯：每个匹配项的祖先都标记为可见
        if (query) {
          const ancestors = new Set();
          allItems.forEach((item, idx) => {
            if (!matchSet.has(item)) return;
            const itemDepth = parseInt(item.dataset.folderDepth) || 0;
            // 向前查找祖先（depth 逐级递减的项）
            let targetDepth = itemDepth - 1;
            for (let i = idx - 1; i >= 0 && targetDepth >= 0; i--) {
              const depth = parseInt(allItems[i].dataset.folderDepth) || 0;
              if (depth === targetDepth) {
                ancestors.add(allItems[i]);
                targetDepth--;
              }
            }
          });
          ancestors.forEach(a => matchSet.add(a));
        }

        let visibleCount = 0;
        allItems.forEach(item => {
          if (!query || matchSet.has(item)) {
            item.style.display = '';
            visibleCount++;
          } else {
            item.style.display = 'none';
          }
        });

        scroll.style.maxHeight = visibleCount <= 6 ? 'none' : '168px';
      });
    }

    confirmBtn.addEventListener('click', () => this._confirm(titleInput));
    overlay.querySelector('.js-cancel').addEventListener('click', () => this._cancel());

    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._confirm(titleInput);
    });
  },

  // ---- 确认 / 取消 ----

  _confirm(titleInput) {
    const newTitle = titleInput.value.trim();
    if (!newTitle) return;

    let newFolderName = null;
    if (this._selectedNewFolder) {
      newFolderName = document.querySelector('.js-new-folder-input')?.value.trim();
      if (!newFolderName) {
        const el = document.querySelector('.js-new-folder-input');
        el?.focus();
        el?.classList.add('sb-input-error');
        return;
      }
    }

    const folderId = this._selectedNewFolder ? null : this._selectedFolderId;
    const folderName = this._selectedNewFolder ? null : this._selectedFolderName;

    this._remove();
    this._resolve({
      action: 'confirm',
      title: newTitle,
      url: this._pageInfo.url,
      folderId,
      folderName,
      newFolder: this._selectedNewFolder,
      newFolderName
    });
  },

  _cancel() {
    this._remove();
    this._resolve({ action: 'cancel' });
  },

  _removeBookmark() {
    const data = this._bookmarkedData;
    this._remove();
    this._resolve({ action: 'remove', bookmarkId: data?.bookmarkId });
  },

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
