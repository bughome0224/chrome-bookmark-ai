# 智能收藏夹

[![GitHub Stars](https://img.shields.io/github/stars/bughome0224/chrome-bookmark-ai?style=flat-square&color=3b82f6)](https://github.com/bughome0224/chrome-bookmark-ai/stargazers)
[![GitHub Release](https://img.shields.io/github/v/release/bughome0224/chrome-bookmark-ai?style=flat-square&color=16a34a)](https://github.com/bughome0224/chrome-bookmark-ai/releases)
[![License](https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square)](LICENSE)

AI 驱动的 Chrome 书签自动分类扩展。收藏网页时，AI 分析页面内容，自动推荐最合适的存放文件夹。

## 功能

- **AI 智能分类** — 按 Ctrl+D 弹出分类窗口，AI 根据页面标题、URL、描述推荐最匹配的现有文件夹
- **即时 Loading** — 弹窗立即出现并显示「AI 正在分析页面内容…」，结果返回后自动切换
- **自动新建文件夹** — 无合适文件夹时 AI 建议新建，一键创建于书签栏
- **已收藏检测** — 重复收藏时显示当前收藏位置，支持一键移除
- **目录树浏览** — 弹窗底部树形展示完整文件夹层级（含连接线），支持搜索过滤及上级目录自动展开
- **AI 幻觉防御** — AI 返回不存在的文件夹名时自动降级为新建模式
- **页面滚动锁定** — 弹窗打开时锁定背景页面，防止误操作
- **多 AI 服务商** — 支持 Anthropic Claude、OpenAI GPT、DeepSeek，`config.json` 自由扩展
- **在线刷新模型** — 设置页面一键从 API 拉取最新模型列表，与本地配置合并
- **本地降级** — API 不可用时自动切换为关键词匹配

## 安装

```bash
git clone <repo-url>
cd chrome-bookmark-ai
```

1. 打开 Chrome → `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择项目目录

## 配置

1. 右键扩展图标 → 「选项」
2. 选择 AI 服务商（Anthropic / OpenAI / DeepSeek）
3. 填入 API Key → 保存
4. 可选：点击模型旁的刷新按钮从 API 拉取最新模型列表

## 使用

| 操作 | 效果 |
|------|------|
| `Ctrl+D` / `Cmd+D` | 弹出智能分类窗口，自动锁定背景页面 |
| 点击扩展图标 → 「智能收藏此页面」 | 同上。未配置 API Key 时按钮禁用并提示 |
| 选中 AI 推荐文件夹 → 确认收藏 | 书签存入对应文件夹 |
| 选择「新建文件夹」→ 输入名称 → 确认 | 在书签栏创建文件夹并存入（空名称时红色抖动提示） |
| 目录树中选择文件夹 | 手动指定任意已有文件夹，选中后蓝色高亮 |
| 搜索框输入关键字 | 实时过滤文件夹，自动展示匹配项的上级目录 |
| 已收藏页面再次 Ctrl+D | 显示收藏位置，点击红色「移除」按钮取消收藏 |

## 降级策略

AI API 不可用时自动降级为本地关键词匹配：基于 URL 域名（如 `github.com` → 技术开发）和页面标题与现有文件夹名称做相似度匹配。

## 项目结构

```
chrome-bookmark-ai/
├── manifest.json              # Chrome Extension Manifest V3
├── config.json                # AI 服务商和模型配置（可自由扩展）
├── background/
│   └── service-worker.js      # 核心调度：书签 CRUD、AI 调用、通知、文件夹树
├── content/
│   └── content.js             # 页面注入：Ctrl+D 拦截、弹窗触发、已收藏移除
├── dialog/
│   ├── dialog.js              # 弹窗 UI：loading、推荐列表、树形浏览器、搜索过滤
│   └── dialog.css             # 弹窗样式：树状连接线、暗色主题、动画
├── options/
│   ├── options.html           # 设置页面（动态渲染服务商/模型）
│   ├── options.css
│   └── options.js             # API Key 配置、在线模型刷新
├── popup/
│   ├── popup.html             # 扩展弹窗（备用入口、API Key 检测）
│   ├── popup.css
│   └── popup.js
├── utils/
│   └── classifier.js          # AI 分类：Prompt 构建、API 适配、幻觉防御、本地降级
└── icons/                     # 扩展图标 (16/48/128)
```

## 扩展 AI 服务商

编辑 `config.json` 添加新 provider：

```json
{
  "providers": [
    {
      "id": "custom",
      "name": "自定义服务",
      "apiUrl": "https://api.example.com/v1/chat/completions",
      "apiFormat": "openai",
      "modelsEndpoint": "https://api.example.com/v1/models",
      "models": [
        { "id": "model-name", "name": "显示名称" }
      ]
    }
  ]
}
```

- `apiFormat`: `"anthropic"` 或 `"openai"`（OpenAI 兼容接口用后者）
- `modelsEndpoint`: 设为 API 地址可启用在线刷新模型，设为 `null` 只使用静态列表

## 核心架构

```
用户 Ctrl+D
  │
  ├─ content.js 拦截键盘事件，提取页面信息
  ├─ Dialog 立即弹出（loading spinner）
  ├─ service-worker.js 获取文件夹树 + 调用 AI API
  ├─ classifier.js 构建 Prompt → 调用 AI → 解析结果 → 幻觉校验
  ├─ Dialog 更新：AI 推荐列表 / 新建建议 / 已收藏提示
  └─ 用户确认 → service-worker.js 创建书签（含自动新建文件夹兜底）
```
