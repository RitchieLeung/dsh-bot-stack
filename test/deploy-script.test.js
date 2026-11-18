import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, 'scripts', 'deploy-146.sh');
const REMOTE = join(ROOT, 'scripts', 'remote-deploy.sh');

test('deployment shell scripts pass bash syntax checks', () => {
  execFileSync('bash', ['-n', LOCAL]);
  execFileSync('bash', ['-n', REMOTE]);
});

test('local dry-run performs no ssh, rsync, npm, or systemctl actions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-dry-'));
  const log = join(dir, 'calls.log');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['ssh', 'rsync', 'npm', 'systemctl', 'sudo']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${log}'\nexit 99\n`);
    execFileSync('chmod', ['+x', join(bin, name)]);
  }
  const result = spawnSync('bash', [LOCAL, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_TEST_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run/i);
  assert.equal(existsSync(log), false, 'dry-run 不应调用任何外部部署命令');
});

test('deployment message expands HEAD safely before Chinese punctuation on Bash 3.2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-head-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['npm', 'ssh', 'rsync']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    execFileSync('chmod', ['+x', join(bin, name)]);
  }
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ stack: { head: 'test-head', buildId: 'test-build' } }));
  const result = spawnSync('bash', [LOCAL, '--allow-dirty'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DIST_DIR: dist,
      REMOTE_ROOT: join(dir, 'remote'),
      DSH_NODE_HOME: join(dir, 'node24'),
    },
  });
  assert.equal(result.status, 0, `不应在部署日志处失败：${result.stderr}`);
  assert.match(result.stdout, /部署 .*（build .*）到/);
});

test('backup_paths and restore_paths restore profile, node_modules, and data together', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-restore-'));
  const profile = join(root, 'profile');
  const data = join(root, 'data');
  const backup = join(root, 'backup');
  mkdirSync(join(profile, 'node_modules', 'dscord'), { recursive: true });
  mkdirSync(join(data, 'bot', 'issue'), { recursive: true });
  mkdirSync(join(data, 'dscord', 'nodes'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), '{"old":true}\n');
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'old-lock\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), '# old patch\n');
  writeFileSync(join(profile, 'node_modules', 'dscord', 'version.txt'), 'old-package\n');
  writeFileSync(join(data, 'bot', 'issue', 'issue.sqlite'), 'old-issue\n');
  writeFileSync(join(data, 'dscord', 'nodes', 'state.json'), 'old-state\n');

  execFileSync('bash', ['-c', 'source "$1"; backup_paths "$2" "$3" "$4"', '_', REMOTE, profile, data, backup]);
  assert.ok(existsSync(join(backup, 'data.tgz')));

  writeFileSync(join(profile, 'package.json'), '{"new":true}\n');
  writeFileSync(join(profile, 'node_modules', 'dscord', 'version.txt'), 'new-package\n');
  writeFileSync(join(data, 'bot', 'issue', 'issue.sqlite'), 'new-issue\n');
  mkdirSync(join(data, 'bot', 'new-dir'));
  writeFileSync(join(data, 'bot', 'new-dir', 'junk'), 'junk');

  execFileSync('bash', ['-c', 'source "$1"; restore_paths "$2" "$3" "$4"', '_', REMOTE, profile, data, backup]);
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), '{"old":true}\n');
  assert.equal(readFileSync(join(profile, 'node_modules', 'dscord', 'version.txt'), 'utf8'), 'old-package\n');
  assert.equal(readFileSync(join(data, 'bot', 'issue', 'issue.sqlite'), 'utf8'), 'old-issue\n');
  assert.equal(existsSync(join(data, 'bot', 'new-dir')), false);
});

test('remote script pins safe deployment and rollback behavior', () => {
  const source = readFileSync(REMOTE, 'utf8');
  for (const expected of [
    'systemctl stop',
    'data.tgz',
    'install.mjs',
    '--ignore-scripts',
    'tools.json',
    '--frozen-lockfile',
    'plugins/events',
    'tail -n +6',
  ]) {
    assert.ok(source.includes(expected), `缺少部署/回滚要件：${expected}`);
  }
  assert.ok(source.indexOf('systemctl stop') < source.indexOf('backup_paths "$profileDir"'), '必须先停服务再备份');
  assert.ok(source.lastIndexOf('trap - ERR') < source.indexOf('ln -sfn'), '健康检查后必须先解除回滚 trap，再做 current/cleanup');
  assert.ok(source.includes("grep -v '/current/$'"), 'release 保留数不能把 current symlink 算进去');
  assert.ok(!source.includes('/home/liangliqiang'), '公共脚本不能写死作者用户名');
});

test('unsafe dataHome is rejected before any rm or tar invocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsafe-home-'));
  const profile = join(dir, 'profile');
  const backup = join(dir, 'backup');
  mkdirSync(profile, { recursive: true });
  mkdirSync(backup);
  writeFileSync(join(backup, 'data.tgz'), 'not-used');
  const log = join(dir, 'calls');
  const result = spawnSync('bash', ['-c', `
    source "$1"
    rm() { echo rm >> "$4"; }
    tar() { echo tar >> "$4"; }
    set +e
    restore_paths "$2" / "$3"
  `, '_', REMOTE, profile, backup, log], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'DSH_HOME=/ 必须被拒绝');
  assert.equal(existsSync(log), false, '危险路径下不能执行 rm/tar');
});

test('backup accepts a fresh host and restore verifies the archive before deleting data', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-backup-'));
  const profile = join(root, 'profile');
  const data = join(root, 'data');
  const backup = join(root, 'backup');
  mkdirSync(profile, { recursive: true });
  mkdirSync(data, { recursive: true });

  execFileSync('bash', ['-c', 'source "$1"; backup_paths "$2" "$3" "$4"', '_', REMOTE, profile, data, backup]);
  assert.ok(existsSync(join(backup, 'data.tgz')), '没有既有 bot/dscord 数据也应能备份');

  writeFileSync(join(data, 'keep.txt'), 'keep');
  writeFileSync(join(backup, 'data.tgz'), 'corrupt');
  const result = spawnSync('bash', ['-c', 'source "$1"; restore_paths "$2" "$3" "$4"', '_', REMOTE, profile, data, backup], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, '损坏归档应拒绝恢复');
  assert.equal(readFileSync(join(data, 'keep.txt'), 'utf8'), 'keep', '验证归档前不能先删数据');
});
