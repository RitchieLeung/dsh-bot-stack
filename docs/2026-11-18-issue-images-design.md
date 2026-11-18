# 事务图片：bot 能在评论里贴图，别的 bot 能真的看到

日期：2026-11-18
状态：待批准

## 为什么

Bot 现在可以自己截图（Playwright 跑完页面存 PNG），但**没有任何办法把图贴进事务**：

- `issue_comment` 只有 `{ id, body }`
- 附件表虽然存在，但没有面向 Bot 的上传通道（用户侧是浏览器上传，Bot 调不到）

而且就算贴进去了，**别的 Bot 也看不到**：评论里存的是 `![](/api/bot-issue?attachment=xxx)` 这种 URL，
Bot 读图必须用 `read_image` 读本地路径，只会拿到 URL——这正是 #7 里「kiki 看不了图」的老毛病。

所以这件事有两层，只做第一层等于没解决传图问题。

## 目标

1. Bot 一次工具调用就能把本地图片带进评论（截图、生成图、设计稿）
2. 人能在面板里直接看到（现有 markdown 渲染已经支持，无需改客户端）
3. **Bot 之间能互通**：任何 Bot 读事务都能拿到图片的本地路径并 `read_image`

## 非目标

- 不做视频 / 任意文件类型。沿用现有 mime 白名单：png / jpeg / webp / gif
- 不做「给一个 URL 自动下载」——Bot 必须自己把文件落盘
- 不做缩略图 / 压缩 / 图床
- 不改用户侧上传（浏览器 → `action=upload` 那条路已经能用）
- 不做删除图片、编辑已有评论

## 反目标（这样算失败）

- 图片存进去了但没人能引用 → 孤儿附件堆积
- 任何非图片文件能借 `images` 参数混进附件库
- 大图把事务库或磁盘打爆
- 评论正文里塞一堆本地路径噪音，人看起来变脏

## 选型

| 方案 | 结论 |
|---|---|
| **A. 工具参数带 `images` + 升级 `issue_get` 返回本地路径** | **采用** |
| B. 独立 `issue_attach` 工具，返回 markdown 片段让 Bot 自己贴 | 弃用：两步调用，Bot 忘第二步就留孤儿附件 |
| C. 只做「人看得到」，不碰 `issue_get` | 弃用：Bot 之间传图仍然断着，等于没解决 #7 的老问题 |

选 A 的理由：一次调用原子完成（图存了、正文一定引用了），且顺手补上「Bot 看得到图」这条链路。
底层复用现有 `addAttachment`——mime 白名单、大小上限、sha256 去重都是现成的。

## 设计

### 1. 三个工具都接受 `images`

`issue_comment(id, body, images)`、`issue_create(..., images)`、`issue_update(..., images)`。

- `images`：本地图片文件路径数组，**必须绝对路径或 `~` 开头**（相对路径会被拒绝并说明原因——不同 Bot 的 cwd 不同，猜 cwd 是坑）
- 单次上限 8 张、单张走现有 `ATTACHMENT_MAX_BYTES`
- 扩展名 → mime 映射：`.png/.jpg/.jpeg/.webp/.gif`，其他扩展名直接拒绝
- 文件不存在 / 不是文件 / 空文件 → 报错并指出是哪一条路径
- 读文件 → base64 → `addAttachment({ issueId, name, mime, data })` → 拿 `url`
- 生成 markdown：`![<文件名>](<url>)`，追加到正文末尾（每行一张）

### 2. 正文语义

- `issue_comment`：`body` 原本要求非空。带 `images` 时允许 body 为空——追加图片 markdown 之后正文自然非空
- `issue_create`：追加到新事务正文末尾
- `issue_update`：追加到「这次最终生效的正文」末尾（有 `body` 用新 body，没有则用现有 body），写回

### 3. 图片数量提示

「📎 N 张图」**不写进存储的正文**（避免正文噪音、也避免反复更新时叠加），而是放在：

- 工具返回的 `render` 文本里（调用方看得见）
- `issue_get` 的文本渲染里（读方看得见）

面板本身能渲染图片，不需要这行。

### 4. `issue_get` 升级：把图 stage 出来

`issue_get` 返回新增 `attachments` 字段，保持 `comments` 仍是字符串数组（不破坏现有调用方）：

```
attachments: [
  { where: 'body' | 'comment:<id>', name, mime, bytes, url, path }
]
```

- `path` 是把附件复制到共享工作区后的本地绝对路径：`<stagingDir>/<issueNumber>/<name>`
- 扫描正文 + 每条评论里的 `?attachment=<id>`，按 id 去重
- 安全阀：单次最多 stage 20 个文件 / 50MB，超出跳过并标明「跳过 N 个」
- 复制失败（磁盘满、文件被删）不报错整体失败，只在条目上标记 `path: null, note: '...'`

### 5. 通知不变

`issue_comment` 之后照旧触发 `notifyMentions` + `notifyCounterpart`，摘要里带一句图片数量即可。

### 6. Skill 文档

`skills/issue-workflow/SKILL.md` 补两句：

- 做完任务有截图/产出图时，用 `issue_comment(..., images: ['/abs/shot.png'])` 贴进评论，不要只说「已截图」却不给图
- 要看看别人贴的图，先 `issue_get` 拿 `attachments[].path`，再 `read_image` 读那个路径（不要拿 URL 去读，读不到）

## 约束

- 零依赖、无构建：只用 `node:fs` / `node:path` / `node:os`
- 不改客户端（面板已经能渲染 markdown 图片，CSS `.is-md img{max-width:100%}`）
- 不改数据库 schema（`attachments` 表已有 `issueId`，评论的图挂 issue 上就够）
- 现有 117 个测试必须继续全绿

## 留给实现者的决定

- stage 目录名冲突（同名不同图）怎么处理：按 `<sha16>-<name>` 落盘，避免互相覆盖
- `issue_get` 的 `render` 文本怎么排版图片列表（一行一个「第 N 张：<name>」即可）
- 错误码命名（沿用仓库现有 `failure(code, message)` 风格）
