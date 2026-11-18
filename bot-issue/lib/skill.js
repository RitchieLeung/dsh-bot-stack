/**
 * 内置「事务规则」provider skill：给团队每个成员一份共用的事务工作流规则。
 *
 * 参照 dscord 的 goal-skills.js / office-skills.js 模式：读 SKILL.md，解析 frontmatter
 * `description`，注册成 model-invocable 的 skill。硬规则（执行人主 Bot-only、闭环/打回门、
 * 能力+负载路由）由 host 的代码兜底；这里负责把「怎么配合」教给每个 Bot。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDER = 'bot-issue-workflow';
const SKILL = 'issue-workflow';
const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL);
const LOCATOR = join(DIRECTORY, 'SKILL.md');

function parseSkill(raw) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  const metadata = frontmatter?.[1] ? Object.fromEntries(
    frontmatter[1].split('\n').map(line => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? []).filter(p => p.length === 2)) : {};
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`${PROVIDER}: ${LOCATOR} has no description`);
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() };
}

/** dsh skills service 的 provider：list() 返回候选，get(item) 返回带 content 的 skill。 */
export function issueWorkflowProvider() {
  const { description } = parseSkill(readFileSync(LOCATOR, 'utf8'));
  const candidate = {
    name: SKILL,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: 500,
    resourceBase: { kind: 'directory', path: DIRECTORY.split(sep).join('/') },
    locator: LOCATOR,
  };
  return {
    name: PROVIDER,
    list: () => Promise.resolve([candidate]),
    async get(item) {
      const { description, content } = parseSkill(readFileSync(item.locator, 'utf8'));
      return { ...item, description, content };
    },
  };
}
