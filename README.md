# dsh-plugin-bot-issue

事务（issue）管理模块：每件事从一个 issue 出发。

与知识库（`dsh-plugin-bot-knowledge`）**平级**，不是它的子模块。知识库只读展示
Bot 的记忆；这个插件拥有自己的可写数据库、自己的 HTTP 路由、自己的模型工具和
自己的面板。

## 能力

- **issue 一等对象**：标题、正文、状态、经办人（主 Bot）、父 issue、时间线、评论、结果。
- **主 Bot 工具** `issue_create / issue_list / issue_get / issue_update / issue_comment`。
- **「事务」面板**：列表（按状态筛选）、新建、详情（时间线 + 评论 + 派工记录）、状态流转。
- **状态机**：`open → discussing → dispatched → in_review → done | failed | cancelled`。
  已派工（dispatched）的 issue 由工作者独占，不能重复派工。

## 派工闭环（Phase 2，见计划文档）

「启动派工」复用 dscord 的 `dispatch_work`：issue 作为派工起点（origin-less 派工，
origin 由 issue 提供），工作者 `work_report done/failed` 后由写回轮询把结果同步到
issue（done → `in_review`，failed → `failed`），闭环者写回。

## 数据

- issue 库：`~/.dsh/bot/issue/issue.sqlite`（`issues` / `comments` / `dispatches` 三表）
- 主 Bot 身份：读 dscord 的 `~/.dsh/bot/state.json`（`mainBotIds`），不写死名字
  （Mac 鲸鱼 / 146 小欣）。

## 目录

- `lib/store.js` — SQLite + 状态机 + 版本守卫（可单测，无 Cordis）
- `lib/handler.js` — 纯 HTTP 请求/响应契约
- `lib/host.js` — HTTP 路由 `/api/bot-issue` + `issue_*` 模型工具
- `lib/client.js` — 「事务」面板（sidebar.panellist + main）
- `test/` — store 与 handler 测试

## 测试

```bash
node --test test/*.test.js
```
