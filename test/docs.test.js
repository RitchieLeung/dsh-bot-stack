import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

test('README is an installation and first-use entry point, not only architecture notes', () => {
  const readme = read('README.md');
  for (const expected of [
    'AI 助手',
    '24.19',
    '0.2.2-rc.1',
    '怎么安装',
    'npm run pack:release',
    'node scripts/install.mjs',
    '装完之后',
    'docs/usage.md',
  ]) {
    assert.ok(readme.includes(expected), `README 缺少：${expected}`);
  }
  assert.ok(!readme.includes('/Users/ritchie_leung'));
  assert.ok(!readme.includes('146.56.202.108'));
  assert.ok(!readme.includes('dsh-plugin-bot-ebook'));
});

test('README avoids maintainer-only deployment jargon and internal topology', () => {
  const readme = read('README.md');
  for (const jargon of [
    'deploy:146', '146 部署', 'dsh.profile.bundles', 'prerelease', 'tarball',
    'HMR', 'Cordis', 'profile', 'systemd', 'pnpm', 'worker', 'Core/PWA',
    '~/.dsh/bot/workspace', '发布镜像',
  ]) {
    assert.ok(!readme.includes(jargon), `公开首页不应出现术语/内部信息：${jargon}`);
  }
});

test('installation, configuration, usage, and rollback documents exist', () => {
  for (const file of ['install', 'configuration', 'usage', 'deploy-146']) {
    const path = `docs/${file}.md`;
    assert.ok(existsSync(join(ROOT, path)), `缺少 ${path}`);
    assert.ok(read(path).length > 500, `${path} 内容过短`);
  }
  const deploy = read('docs/deploy-146.md');
  assert.ok(deploy.includes('回滚'));
  assert.ok(deploy.includes('.deploy-146.env'));
  assert.ok(deploy.includes('dsh-web.service'));
});

test('release workflow actually checks, packs, and publishes artifacts', () => {
  const workflow = read('.github/workflows/release.yml');
  for (const expected of ['stack-v*', 'npm run check', 'npm run pack:release', 'SHA256SUMS', 'manifest.json', 'contents: write']) {
    assert.ok(workflow.includes(expected), `release workflow 缺少 ${expected}`);
  }
});

test('public deployment scripts do not embed the pilot server IP', () => {
  for (const file of ['scripts/deploy-146.sh', 'scripts/remote-deploy.sh']) {
    assert.ok(!read(file).includes('146.56.202.108'), `${file} 不应写死试点 IP`);
  }
});
