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

## 装到另一台 dsh 主机（以 146 为例）

`ssh 146.56.202.108`，四条都要做，少一条就是「面板在但 Bot 用不了」。

1. **插件本体**：`rsync -a --exclude=node_modules bot-issue/ 146:/home/liangliqiang/bot-issue/`
2. **装进 profile**（`link:`，改代码刷新页面即可，不用重装）：
   ```bash
   dsh plugin --profile web add link:/home/liangliqiang/bot-issue
   ```
3. **dscord fork 要跟上**（`issue_*` 进 `FRONT_TOOLS`、消息里 `#N` 变超链接、
   无房间消息的 turn 也 `serveFront`）：把 `dsh-connect/{work-core,native-bridge,client}.mjs|js`
   同步到对方 `~/dscord-fork`，再 `~/dscord-fork/sync.sh` 推到 profile 的
   `node_modules/dscord`（`file:` 装的是快照，不同步不生效）。
   **注意**：146 的 `dsh-connect/controller.mjs` 有一段本机专用补丁（公网 IP hairpin 改走
   127.0.0.1），不要整目录覆盖。
4. **dsh 的 `#` 触发补丁**：
   ```bash
   node patches/patch-hash-trigger.cjs <dsh 安装目录>/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib
   ```
   dsh 升级会被覆盖，升级后重跑（幂等，会先校验结构再改）。

最后 `sudo systemctl restart dsh-web`（146 是 systemd 管的，`Restart=always`）。

验证（在对方机器上）：

```bash
curl -s localhost:3080/plugins/events | grep -o '"id":"dsh-plugin-bot-issue"'   # 面板已注册
node --test test/*.test.js                                                      # 用 v24 跑，node:sqlite 需要 22+
```

再 `POST /api/bot-issue {"action":"meta"}`，`mainBot` 应该是那台机器自己的主 Bot
（146 是小欣），`roster` 是那台的同事——不是 Mac 的鲸鱼就说明 `state.json` 读对了。
