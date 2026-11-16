/**
 * 给 dsh 的输入补全管线加 `#` 触发（事务编号补全）。
 * 与 bot-issue 仓库的 patches/dsh-hash-trigger.md 一致；幂等，可重复运行。
 *
 * 用法：node patch-hash-trigger.cjs <dsh-client-ui-input-trigger 的 lib 目录>
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node patch-hash-trigger.cjs <dsh-client-ui-input-trigger/lib 目录>');
  process.exit(1);
}
const clientFile = path.join(dir, 'client.js');
let source = fs.readFileSync(clientFile, 'utf8');
const original = source;

// 1) 触发行也接受 `#`
if (!source.includes('if (ch !== "/" && ch !== "#") continue;')) {
  const hits = source.split('if (ch !== "/") continue;').length - 1;
  if (hits !== 1) {
    console.error(`找不到唯一的 detectTrigger 触发行（命中 ${hits} 次），dsh 版本可能变了，停止。`);
    process.exit(2);
  }
  source = source.replace('if (ch !== "/") continue;', 'if (ch !== "/" && ch !== "#") continue;');
}

// 2) `#` 的边界：URL 片段 `/#` 不弹候选
const anchor = [
  '\t\t\tif (char === "/") {',
  '\t\t\t\tif (prev === "/") return false;',
  '\t\t\t\tif (prev === ":" && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;',
  '\t\t\t}',
  '\t\t\treturn true;',
].join('\n');
if (!source.includes('if (char === "#" && prev === "/") return false;')) {
  if (!source.includes(anchor)) {
    console.error('boundaryOk 的结构和预期不一致，dsh 版本可能变了，停止。');
    process.exit(3);
  }
  source = source.replace(anchor, anchor.replace('\t\t\treturn true;', '\t\t\tif (char === "#" && prev === "/") return false;\n\t\t\treturn true;'));
}

if (source !== original) {
  fs.writeFileSync(clientFile, source);
  console.log('client.js: 已打补丁');
} else {
  console.log('client.js: 已经是打过补丁的状态');
}

// 3) 类型声明（只影响类型，保持诚实）
const typesFile = path.join(dir, 'types', 'types.d.ts');
let types = fs.readFileSync(typesFile, 'utf8');
if (types.includes("export type TriggerChar = '/' | '@' | '#';")) {
  console.log('types.d.ts: 已经是打过补丁的状态');
} else if (types.includes("export type TriggerChar = '/' | '@';")) {
  fs.writeFileSync(typesFile, types.replace("export type TriggerChar = '/' | '@';", "export type TriggerChar = '/' | '@' | '#';"));
  console.log('types.d.ts: 已打补丁');
} else {
  console.warn('types.d.ts: 没找到 TriggerChar 定义，跳过（运行时不受影响）');
}
