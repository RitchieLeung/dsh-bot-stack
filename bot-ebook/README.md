# dsh-plugin-bot-ebook

电子书模块：把 PDF / 网页 / markdown 书稿**自助采集**成本机书库，像看书一样翻阅，
阅读时还能唤起一个**锚定本书的 agent 助手**提问（类似 NotebookLM）。

与事务（`dsh-plugin-bot-issue`）、知识库（`dsh-plugin-bot-knowledge`）平级：同一个
profile 里各自一条 plugin row，有自己的库、自己的 HTTP 路由、自己的模型工具、自己的面板。

## 能力

- **通用采集**：面板右上角「导入」→ 上传 PDF（文字版）/ EPUB / md / txt / html，或贴一个
  网页链接 → 模型（默认 deepseek-flash）把原文转成结构化 markdown → 预览 → 确认入库。
- **阅读助手**：阅读页右下角「问书」浮球 → 滑出聊天浮窗。助手是**真正的 agent 子会话**
  （不是裸 LLM），自己调 `ebook_read / ebook_search` 检索原文再回答，`§N` 引用可点跳回原章。
- **书库**：一本书 = `books` 一行 + 若干章（`chapters.idx` 排序，`groupName` 只做分组
  标签，所以重新导入不需要改表结构）。
- **阅读器面板**：左侧书目 → 分组（导读 / 正文 / 习题 / 附录）→ 章节；正文按 markdown
  渲染（标题、段落、代码块、表格、引用、列表、行间公式原样展示）。左侧目录可收起，手机端是抽屉。
- **全文搜索**：搜一个词，列命中章节 + 上下文片段，点一下跳过去。
- **阅读进度**：记住每本书读到第几章、滚到第几像素，存库里（换浏览器、重开都在）。
- **键盘翻章**：← / → 上一章 / 下一章；顶部还有「本章目录」跳到本章小节。
- **Bot 工具**：`ebook_list / ebook_read / ebook_search`——Bot 能自己读书、检索、讲解。

## 模型

采集转换和助手都走 harness 的模型服务。默认 `deepseek-official/deepseek-flash`；
可在插件配置里用 `model: { provider, model }` 覆盖成任意已配置模型。

## 数据

- 书库：`~/.dsh/bot/ebook/ebook.sqlite`（`books` / `chapters` / `progress`）
- 章节正文存 markdown 原文（导入时只去 frontmatter，不改写内容）

## 导入书稿

现成的脚本针对 [psmarter/PMPP-Learning](https://github.com/psmarter/PMPP-Learning)
（PMPP 第四版中文学习笔记：22 篇正文 + 导读 + 20 章习题解答，MIT）：

```bash
node scripts/import-pmpp.mjs                  # 从 GitHub 拉最新并导入
node scripts/import-pmpp.mjs --dir /tmp/pmpp  # 用本地已解压的仓库
node scripts/import-pmpp.mjs --db /tmp/x.sqlite
```

导入是**整本替换**：章节按 idx 重建，阅读进度按 idx 夹紧（书变短也不会丢位置）。

换别的书：只要目录形状是「一堆 markdown」，照 `scripts/import-pmpp.mjs` 里的
`collectChapters()` 改排序规则，或者直接调 `store.replaceBook(book, chapters)`。

## 目录

- `lib/store.js` — SQLite：书目、章节、搜索、进度（无 Cordis，可单测）
- `lib/ingest.js` — 采集机械层：分块 / 拆章 / 网页抽正文 / 模型转换提示词（可单测）
- `lib/assistant.js` — 助手：agent 子会话管理（创建/复用/投递）+ 引用组装（可单测）
- `lib/pdf.js` — PDF 抽文字（pdfjs-dist，动态 import）
- `lib/handler.js` — 纯 HTTP 请求/响应契约
- `lib/host.js` — HTTP 路由 `/api/bot-ebook` + 三个模型工具 + 注入 llm/web/agents/sessionController
- `lib/client.js` — 「电子书」面板（sidebar.panellist + main），含导入对话框、助手浮窗、markdown 解析
- `scripts/import-pmpp.mjs` — 书稿导入
- `test/` — store / ingest / assistant / handler / host / markdown / import

## 测试

```bash
node --test test/*.test.js
```

## 装到别的 dsh 主机

和事务插件同一套做法：把目录 rsync 过去，`dsh plugin --profile web add link:<目录>`，
再在那边跑一次 `node scripts/import-pmpp.mjs`（书库是本机的，不同步数据库文件），
最后 `systemctl restart dsh-web`（或重启 `dsh web`）。
