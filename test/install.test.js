import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = join(ROOT, 'scripts', 'pack.mjs');
const INSTALL = join(ROOT, 'scripts', 'install.mjs');
const DEFINITIONS = [
  ['dscord', 'dscord', '0.4.0-alpha.2'],
  ['bot-issue', 'dsh-plugin-bot-issue', '0.1.0'],
  ['bot-knowledge', 'dsh-plugin-bot-knowledge', '0.1.0'],
];

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'stack-install-'));
  for (const [directory, name, version] of DEFINITIONS) {
    mkdirSync(join(root, directory, 'lib'), { recursive: true });
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name, version, type: 'module' }));
    writeFileSync(join(root, directory, 'cordis.patch.yml'), `# ${name}\n`);
    writeFileSync(join(root, directory, 'lib', 'host.js'), 'export const name = "fixture";\n');
  }
  execFileSync(process.execPath, [PACK, '--root', root, '--build-id', 'test.install'], { stdio: 'pipe' });

  const home = join(root, 'home');
  const profileDir = join(home, '.dsh', 'profiles', 'web');
  mkdirSync(join(profileDir, 'node_modules', 'dscord'), { recursive: true });
  const originalPackage = {
    name: 'profile',
    dependencies: { dscord: 'file:/old/dscord' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    custom: { keep: true },
  };
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(originalPackage, null, 2)}\n`);
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# keep this patch\n');
  writeFileSync(join(profileDir, 'node_modules', 'dscord', 'package.json'), '{"name":"dscord","version":"old"}\n');

  const dshBin = join(root, 'fake-dsh.mjs');
  writeFileSync(dshBin, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_DSH_REQUIRE_OWN_PATH && process.env.PATH.split(':')[0] !== dirname(process.argv[1])) {
  console.error('dsh 被错误的 PATH/node 调用'); process.exit(1);
}
if (args.includes('--version')) { console.log(process.env.FAKE_DSH_VERSION || '0.2.2-rc.1'); process.exit(0); }
if (args[0] !== 'plugin') process.exit(2);
const file = args.find(arg => arg.endsWith('.tgz'));
const name = file.includes('dscord-') ? 'dscord' : file.includes('bot-issue-') ? 'dsh-plugin-bot-issue' : 'dsh-plugin-bot-knowledge';
if (process.env.FAKE_DSH_LOG) appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify({ args, name }) + '\\n');
if (process.env.FAKE_DSH_FAIL_ON && file.includes(process.env.FAKE_DSH_FAIL_ON)) process.exit(42);
const profile = process.env.FAKE_PROFILE_DIR;
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
manifest.dependencies ||= {};
manifest.dependencies[name] = 'file:' + file;
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\\n');
mkdirSync(join(profile, 'node_modules', name), { recursive: true });
writeFileSync(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: 'new' }));
if (name === 'dsh-plugin-bot-issue') writeFileSync(join(profile, 'pnpm-lock.yaml'), '  ' + name + '@file:' + file + ':\\n');
`);
  chmodSync(dshBin, 0o755);

  const pnpmBin = join(root, 'pnpm');
  writeFileSync(pnpmBin, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_DSH_LOG) appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify({ pnpm: args }) + '\\n');
if (args[0] === 'approve') writeFileSync(process.env.FAKE_PNPM_STATE, 'approved');
if (args[0] === 'permissions' && args[1] === 'list') {
  const approved = existsSync(process.env.FAKE_PNPM_STATE);
  const lock = readFileSync(join(process.env.FAKE_PROFILE_DIR, 'pnpm-lock.yaml'), 'utf8');
  const selector = lock.trim().replace(/:$/, '');
  if (approved) console.log('Granted:\\n  ' + selector + '  skills');
  else console.log('Awaiting approval:\\n  dsh-plugin-bot-issue (tarball) [' + selector + ']  skills');
  if (process.env.FAKE_PNPM_OTHER_PENDING) console.log('Awaiting approval:\\n  other-package (tarball)  scripts');
}
`);
  chmodSync(pnpmBin, 0o755);

  return {
    root,
    home,
    profileDir,
    dshBin,
    dist: join(root, 'dist'),
    packagesDir: join(root, 'persistent-packages'),
    backupRoot: join(root, 'backup'),
    log: join(root, 'dsh.log'),
    pnpmState: join(root, 'pnpm-approved'),
    originalPackageText: readFileSync(join(profileDir, 'package.json'), 'utf8'),
  };
}

function runInstall(ctx, extra = [], env = {}) {
  return spawnSync(process.execPath, [
    INSTALL,
    '--profile', 'web',
    '--profile-dir', ctx.profileDir,
    '--dist', ctx.dist,
    '--dsh-bin', ctx.dshBin,
    '--packages-dir', ctx.packagesDir,
    '--backup-root', ctx.backupRoot,
    ...extra,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: ctx.home,
      FAKE_PROFILE_DIR: ctx.profileDir,
      FAKE_DSH_LOG: ctx.log,
      FAKE_PNPM_STATE: ctx.pnpmState,
      ...env,
    },
  });
}

test('dry-run validates without changing anything', () => {
  const ctx = workspace();
  const result = runInstall(ctx, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'), ctx.originalPackageText);
  assert.equal(existsSync(ctx.packagesDir), false);
  assert.equal(existsSync(ctx.backupRoot), false);
  assert.equal(existsSync(ctx.log), false);
});

test('a modified tarball is rejected before any write or dsh call', () => {
  const ctx = workspace();
  const manifest = JSON.parse(readFileSync(join(ctx.dist, 'manifest.json'), 'utf8'));
  writeFileSync(join(ctx.dist, manifest.packages[0].filename), 'tampered');
  const result = runInstall(ctx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA256|校验/);
  assert.equal(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'), ctx.originalPackageText);
  assert.equal(existsSync(ctx.packagesDir), false);
  assert.equal(existsSync(ctx.backupRoot), false);
  assert.equal(existsSync(ctx.log), false);
});

test('manifest filenames cannot escape dist or the persistent package directory', () => {
  const ctx = workspace();
  const manifestPath = join(ctx.dist, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const item = manifest.packages[0];
  const bytes = readFileSync(join(ctx.dist, item.filename));
  writeFileSync(join(ctx.root, 'escape.tgz'), bytes);
  item.filename = '../escape.tgz';
  item.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const result = runInstall(ctx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /filename|文件名|路径/);
  assert.equal(existsSync(ctx.packagesDir), false);
});

test('install uses persistent tarballs, activates bundles once, and keeps backups', () => {
  const ctx = workspace();
  const first = runInstall(ctx);
  assert.equal(first.status, 0, first.stderr);

  const installed = JSON.parse(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'));
  assert.equal(installed.custom.keep, true);
  const bundles = installed.dsh.profile.bundles;
  for (const name of ['dscord', 'dsh-plugin-bot-knowledge', 'dsh-plugin-bot-issue']) {
    assert.equal(bundles.filter(item => item === name).length, 1);
    assert.ok(installed.dependencies[name].startsWith(`file:${ctx.packagesDir}`));
  }
  assert.equal(readdirSync(ctx.packagesDir).filter(name => name.endsWith('.tgz')).length, 3);
  assert.equal(existsSync(join(ctx.backupRoot, 'profile', 'package.json')), true);
  assert.equal(existsSync(join(ctx.backupRoot, 'installed', 'dscord', 'package.json')), true);
  const calls = readFileSync(ctx.log, 'utf8');
  assert.ok(!calls.includes('"--all"'), '只能批准 lockfile 里的事务 tarball selector，不能 blanket approve');
  assert.ok(calls.includes('"approve","dsh-plugin-bot-issue@file:'), '必须使用 lockfile 规范化 selector');
  assert.equal(existsSync(ctx.pnpmState), true, '批准后要复核状态');

  const second = runInstall(ctx);
  assert.equal(second.status, 0, second.stderr);
  const again = JSON.parse(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'));
  assert.equal(new Set(again.dsh.profile.bundles).size, again.dsh.profile.bundles.length);
});

test('failure on the second package restores profile and installed package dirs', () => {
  const ctx = workspace();
  const result = runInstall(ctx, [], { FAKE_DSH_FAIL_ON: 'bot-issue-' });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'), ctx.originalPackageText);
  assert.equal(readFileSync(join(ctx.profileDir, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 1\n');
  assert.equal(readFileSync(join(ctx.profileDir, 'node_modules', 'dscord', 'package.json'), 'utf8'), '{"name":"dscord","version":"old"}\n');
  assert.equal(existsSync(join(ctx.profileDir, 'node_modules', 'dsh-plugin-bot-issue')), false);
});

test('dsh is executed with its own Node bin directory first in PATH', () => {
  const ctx = workspace();
  const result = runInstall(ctx, ['--dry-run'], { FAKE_DSH_REQUIRE_OWN_PATH: '1' });
  assert.equal(result.status, 0, `不能用 SSH 默认的旧 Node 启动 dsh：${result.stderr}`);
});

test('another pending package is left untouched while the exact issue selector is approved', () => {
  const ctx = workspace();
  const result = runInstall(ctx, [], { FAKE_PNPM_OTHER_PENDING: '1' });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(ctx.log, 'utf8');
  assert.ok(!calls.includes('"--all"'));
  assert.ok(!calls.includes('other-package'));
  assert.equal(existsSync(ctx.pnpmState), true);
});

test('unsupported DSH and Node versions are rejected', async () => {
  const ctx = workspace();
  const result = runInstall(ctx, [], { FAKE_DSH_VERSION: '0.2.1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0\.2\.2-rc\.1/);
  assert.equal(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'), ctx.originalPackageText);

  const { assertNodeVersion } = await import(INSTALL);
  assert.throws(() => assertNodeVersion('22.14.0'), /24\.19/);
  assert.doesNotThrow(() => assertNodeVersion('24.22.2'));
});
