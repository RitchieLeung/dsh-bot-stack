# dsh 补丁：给输入补全加 `#` 触发

事务编号 `#N` 的 **输入时候选补全**（打 `#` 弹菜单，像 GitLab）依赖 dsh 的输入补全管线
`@deepseek-ai/dsh-client-ui-input-trigger`。该管线默认只认 `/`（命令）和 `@`（文件/会话引用），
`TriggerChar = '/' | '@'`，所以必须给它打一个小补丁。

> 改动在 **dsh 安装目录**（`$DSH_INSTALL/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/`），
> **dsh 升级会被覆盖**，升级后按下面的 diff 重新打。

## 补丁内容（两处，运行时一处 + 类型一处）

文件：`node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js`

### 1) 让触发行也匹配 `#`

`detectTrigger` 里反向扫描的那段：

```diff
-				if (ch !== "/") continue;
+				if (ch !== "/" && ch !== "#") continue;
 				if (guard.tier === "claimed") continue;
 				if (!boundaryOk(draft, i, ch)) continue;
```

### 2) `#` 的边界：URL 片段 `/#` 不触发

`boundaryOk`：

```diff
 			if (char === "/") {
 				if (prev === "/") return false;
 				if (prev === ":" && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
 			}
+			if (char === "#" && prev === "/") return false;
 			return true;
```

文件：`node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/types/types.d.ts`

```diff
-export type TriggerChar = '/' | '@';
+export type TriggerChar = '/' | '@' | '#';
```

（`types.d.ts` 只是类型，运行时不需要，但保持一致。）

## 一次性打补丁脚本

```bash
D="$HOME/.nvm/versions/node/$(node -v | sed 's/^v//')/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib"
node - "$D" <<'EOF'
const fs = require('fs'), p = require('path');
const dir = process.argv[2];
const c = p.join(dir, 'client.js');
let s = fs.readFileSync(c, 'utf8');
s = s.replace('if (ch !== "/") continue;', 'if (ch !== "/" && ch !== "#") continue;');
s = s.replace('if (char === "#" && prev === "/") return false;\n', '');
s = s.replace('			return true;\n		}\n		/**\n		* Detect a trigger token', '			if (char === "#" && prev === "/") return false;\n			return true;\n		}\n		/**\n		* Detect a trigger token');
fs.writeFileSync(c, s);
const t = p.join(dir, 'types/types.d.ts');
let u = fs.readFileSync(t, 'utf8');
u = u.replace("export type TriggerChar = '/' | '@';", "export type TriggerChar = '/' | '@' | '#';");
fs.writeFileSync(t, u);
console.log('patched dsh input-trigger for #');
EOF
```

打完 **重启 dsh** 才会生效（client bundle 在启动时组装）。

## 客户端消费方

`lib/client.js`（本插件）在 `apply` 里：

```js
ctx.inject(['inputTriggers'], inputCtx => inputCtx.inputTriggers.registerSource({
  trigger: '#',
  name: '事务',
  async candidates(_session, req) { /* 拉事务列表按编号/标题过滤 */ },
  onPick(pick) { return { text: `#${pick.candidate.value}` }; },
}));
```

选中后插入 `#N` 纯文本；发送后聊天里的 `#N` 由 dscord 客户端渲染成可点超链接（另一处改动）。
