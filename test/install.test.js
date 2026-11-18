import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
`);
  chmodSync(dshBin, 0o755);

  const pnpmBin = join(root, 'pnpm');
  writeFileSync(pnpmBin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_DSH_LOG) appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify({ pnpm: args }) + '\\n');
if (args[0] === 'permissions' && args[1] === 'list') console.log('Awaiting approval:\\n  dsh-plugin-bot-issue (tarball)  skills' + (process.env.FAKE_PNPM_OTHER_PENDING ? '\\n  other-package (tarball)  scripts' : ''));
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
  assert.ok(calls.includes('"pnpm":["approve","--all","--yes"]'), '确认待批准列表只有事务 skill 后，必须批准 tarball 形态');

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

test('refuses blanket approval when another package or permission is pending', () => {
  const ctx = workspace();
  const result = runInstall(ctx, [], { FAKE_PNPM_OTHER_PENDING: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /其他包|拒绝/);
  const calls = existsSync(ctx.log) ? readFileSync(ctx.log, 'utf8') : '';
  assert.ok(!calls.includes('"pnpm":["approve","--all","--yes"]'));
  assert.equal(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'), ctx.originalPackageText);
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
