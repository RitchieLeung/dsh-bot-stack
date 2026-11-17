# dsh-plugin-bot-issue

事务（issue）管理模块：每件事从一个 issue 出发。

与知识库（`dsh-plugin-bot-knowledge`）**平级**，不是它的子模块。知识库只读展示
Bot 的记忆；这个插件拥有自己的可写数据库、自己的 HTTP 路由、自己的模型工具和
自己的面板。

## 能力

- **issue 一等对象**：标题、正文、状态、经办人（主 Bot）、父 issue、时间线、评论、结果。
- **主 Bot 工具** `issue_create / issue_list / issue_get / issue_update / issue_link / issue_unlink / issue_comment`。
- **「事务」面板**：列表（按状态筛选）、新建、详情（时间线 + 评论 + 派工记录）、状态流转。
- **状态机**：`open → discussing → dispatched → in_review → done | failed | cancelled`。
  已派工（dispatched）的 issue 由工作者独占，不能重复派工。
- **标签（tag）**：像 Notion 的多选标签。标签有独立的库（`tags` 表），库里没有的
  输入回车即新建；悬停标签右边的 `×` 从库里删除（同时把它从所有事务上摘掉）。
  一个事务可挂多个标签，`issues.type` 退化成一号标签的镜像，只为兼容旧调用方。
- **依赖（depends on）**：`A 依赖 B` 记成一条 `issue_links(A → B)` 边，表示
  **B 闭环了 A 才能闭环**。详情页两栏都能加/删：前置（A 依赖谁）和后置（谁等 A）。
  前置没闭环时 `done` 会被服务端拒绝（`BLOCKED_BY_DEPS`），**不拦启动和派活**；
  前置被取消/失败也算没完成（否则取消就成了绕过依赖的后门）；禁止自依赖和成环；
  已闭环的事务不能再挂没完成的前置。
- **执行人（assignee）**：事务记录是哪个 Bot 承接。只有主 Bot 或人（面板）能指派/改派；
  指派写进时间线。
- **能力 + 负载派工**：「启动」时 host 用运行时模型目录（`ctx.llm.resolveModelInfo` 的
  `inputModalities`，不写死）现查同事能不能看图，结合岗位关键词与在手事务数，确定执行人并落库，
  再让主 Bot 只写说明 + `message_bot`。图任务若无能看图的同事则明确拒绝，不瞎派。
- **闭环认可 + 打回**：执行人只能 `进行中 → 待验收`（交结果）；`待验收 → 已闭环`（验收）和
  `待验收 → 进行中`（打回重做，必带打回意见）只有主 Bot 或人能做。交结果/评论自动知会对侧。
- **未读角标**：侧栏「事务」图标右上角出数字角标（未读的状态/评论变化），点开该事务即清，
  存浏览器 localStorage（不进主机）。
- **「事务规则」skill**：内置 provider skill（`issue-workflow`），把上面这套工作流教给全队成员。
  硬规则由代码兜底，skill 负责「怎么配合」。

## 派工闭环（Phase 2，见计划文档）

「启动派工」复用 dscord 的 `dispatch_work`：issue 作为派工起点（origin-less 派工，
origin 由 issue 提供），工作者 `work_report done/failed` 后由写回轮询把结果同步到
issue（done → `in_review`，failed → `failed`），闭环者写回。

## 数据

- issue 库：`~/.dsh/bot/issue/issue.sqlite`（`issues` / `comments` / `dispatches` / `tags` /
  `issue_tags` / `issue_links`）
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

## 改动怎么上线（不重启 dsh）

dsh 的 HMR 只「看得见」profile 目录里的模块文件。插件如果以 `link:` 软链到 workspace，
加载路径在 profile 外，改 host 代码不会被重载。所以插件以**真实副本**装在
`~/.dsh/profiles/web/node_modules/dsh-plugin-<name>/`，改完代码跑：

```bash
dsh-plugin-sync              # 全部
dsh-plugin-sync bot-issue    # 单个
```

它做三件事：rsync 源码到 profile 内的副本 → 追加一行 `# hmr-nudge` 触发 dsh-hmr 的
`reconcileProfile()` → 等 `~/.dsh/bot/issue/health.json` 的 mtime 变新（证明真的重载了）。

注意点（都是踩过的坑）：
- **必须追加、不能重写** patch 文件：dsh-hmr 的监听认 inode，`sed -i`/`mv` 换掉 inode 就看不到变化
- **rsync 要 `--no-times`**：保留旧 mtime 时 HMR 可能认为模块没变
- 部署坏代码不会挂服务：那个 entry 起不来、路由 404，服务本身还活着；再同步回好代码会自动恢复
- `health.json` 只记录 bot-issue；其他插件靠 `/plugins/events` 里还在不在来判断

## 出事了先用急救台

`~/dsh-rescue`（独立进程，端口 3099）能停用插件、重启 dsh、抓登录链接，见那边的 README。
