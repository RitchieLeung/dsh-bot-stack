import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { issueWorkflowProvider } from '../lib/skill.js';

test('SKILL.md 有 description 且覆盖闭环/打回/主Bot/执行人', () => {
  const md = readFileSync(new URL('../skills/issue-workflow/SKILL.md', import.meta.url), 'utf8');
  assert.match(md, /^---\r?\n[\s\S]*?description:[\s\S]*?\r?\n---/);
  assert.match(md, /闭环/);
  assert.match(md, /打回/);
  assert.match(md, /主 Bot/);
  assert.match(md, /执行人/);
});

test('provider 列出 issue-workflow skill 且能取到内容', async () => {
  const provider = issueWorkflowProvider();
  assert.equal(provider.name, 'bot-issue-workflow');
  const list = await provider.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'issue-workflow');
  assert.equal(list[0].invocation.modelInvocable, true);
  const item = await provider.get(list[0]);
  assert.ok(item.content.length > 0);
  assert.match(item.content, /闭环/);
});

test('SKILL.md 说明怎么贴图、怎么看别人贴的图', () => {
  const md = readFileSync(new URL('../skills/issue-workflow/SKILL.md', import.meta.url), 'utf8');
  assert.match(md, /images/);
  assert.match(md, /read_image/);
  assert.match(md, /绝对路径/);
  assert.match(md, /attachments/);
  assert.match(md, /system-reminder/);
});
