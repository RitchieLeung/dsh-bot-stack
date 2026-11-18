#!/usr/bin/env node
/** Install and activate the three stack packages, with rollback on installer failure. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync,
  copyFileSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_DSH = '0.2.2-rc.1';
const EXPECTED_PACKAGES = ['dscord', 'dsh-plugin-bot-issue', 'dsh-plugin-bot-knowledge'];
const EXPECTED_BUNDLES = ['dscord', 'dsh-plugin-bot-knowledge', 'dsh-plugin-bot-issue'];
const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'];

export function assertNodeVersion(version) {
  const [major, minor] = String(version).split('.').map(Number);
  if (major !== 24 || minor < 19) throw new Error(`需要 Node >=24.19 <25，当前是 ${version}`);
}

export function assertDshVersion(version) {
  if (version !== EXPECTED_DSH) throw new Error(`需要 DSH ${EXPECTED_DSH}，当前是 ${version || '未知版本'}`);
}

function parseArgs(argv) {
  const result = { profile: 'web', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--profile') result.profile = argv[++i];
    else if (arg === '--profile-dir') result.profileDir = resolve(argv[++i]);
    else if (arg === '--dist') result.dist = resolve(argv[++i]);
    else if (arg === '--dsh-bin') result.dshBin = argv[++i];
    else if (arg === '--pnpm-bin') result.pnpmBin = argv[++i];
    else if (arg === '--packages-dir') result.packagesDir = resolve(argv[++i]);
    else if (arg === '--backup-root') result.backupRoot = resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return result;
}

function dshEnv(dshBin) {
  const binDir = dirname(dshBin);
  return {
    ...process.env,
    // dsh 的 shebang 是 /usr/bin/env node；SSH 默认 PATH 可能指向系统旧 Node。
    PATH: binDir === '.' ? process.env.PATH : `${binDir}:${process.env.PATH || ''}`,
  };
}

function detectDshVersion(dshBin) {
  const result = spawnSync(dshBin, ['--version'], { encoding: 'utf8', env: dshEnv(dshBin) });
  if (result.status === 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    if (match) {
      assertDshVersion(match[0]);
      return;
    }
  }

  // 某些安装方式下 dsh --version 没有输出；从真实安装路径读 package.json。
  let dir = dirname(realpathSync(dshBin));
  for (let i = 0; i < 8; i += 1) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') {
        assertDshVersion(manifest.version);
        return;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`无法确认 DSH 版本（需要 ${EXPECTED_DSH}）：${dshBin}`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function loadVerifiedPackages(dist) {
  const manifestFile = join(dist, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error(`缺少 ${manifestFile}，先运行 npm run pack`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== EXPECTED_PACKAGES.length) {
    throw new Error('manifest 必须恰好包含三个安装包');
  }
  const byName = new Map(manifest.packages.map(item => [item.name, item]));
  for (const name of EXPECTED_PACKAGES) {
    const item = byName.get(name);
    if (!item) throw new Error(`manifest 缺少 ${name}`);
    const file = join(dist, item.filename);
    if (!existsSync(file)) throw new Error(`缺少安装包：${file}`);
    const actual = sha256(file);
    if (actual !== item.sha256) {
      throw new Error(`${item.filename} SHA256 校验失败：期望 ${item.sha256}，实际 ${actual}`);
    }
  }
  return { manifest, packages: EXPECTED_PACKAGES.map(name => byName.get(name)) };
}

function backup(profileDir, backupRoot) {
  const profileBackup = join(backupRoot, 'profile');
  const installedBackup = join(backupRoot, 'installed');
  mkdirSync(profileBackup, { recursive: true });
  mkdirSync(installedBackup, { recursive: true });

  const files = [];
  for (const name of PROFILE_FILES) {
    const source = join(profileDir, name);
    const existed = existsSync(source);
    files.push({ name, existed });
    if (existed) copyFileSync(source, join(profileBackup, name));
  }
  const packages = [];
  for (const name of EXPECTED_PACKAGES) {
    const source = join(profileDir, 'node_modules', name);
    const existed = existsSync(source);
    packages.push({ name, existed });
    if (existed) cpSync(source, join(installedBackup, name), { recursive: true, dereference: false });
  }
  return { files, packages };
}

function restore(profileDir, backupRoot, saved) {
  for (const item of saved.files) {
    const target = join(profileDir, item.name);
    if (item.existed) copyFileSync(join(backupRoot, 'profile', item.name), target);
    else rmSync(target, { force: true });
  }
  for (const item of saved.packages) {
    const target = join(profileDir, 'node_modules', item.name);
    rmSync(target, { recursive: true, force: true });
    if (item.existed) cpSync(join(backupRoot, 'installed', item.name), target, { recursive: true, dereference: false });
  }
}

function activateBundles(profileDir) {
  const file = join(profileDir, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.dsh ||= {};
  manifest.dsh.profile ||= {};
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = [];
  for (const name of EXPECTED_BUNDLES) {
    if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name);
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function approveIssueSkills(profileDir, dshBin, pnpmBin) {
  const bin = pnpmBin || join(dirname(dshBin), 'pnpm');
  const list = spawnSync(bin, ['permissions', 'list'], {
    cwd: profileDir,
    env: dshEnv(dshBin),
    encoding: 'utf8',
  });
  if (list.error) throw list.error;
  if (list.status !== 0) throw new Error(`pnpm permissions list 失败：${list.stderr || list.stdout}`);
  const output = `${list.stdout || ''}\n${list.stderr || ''}`;
  const awaiting = output.split(/Awaiting approval:/i)[1]?.split(/Run "pnpm approve"/i)[0] || '';
  const pendingLines = awaiting.split('\n').map(line => line.trim()).filter(Boolean);
  if (pendingLines.length === 0) return;
  const onlyIssueSkills = pendingLines.every(line => /^dsh-plugin-bot-issue(?:\s+\(tarball\))?(?:\s+\[dsh-plugin-bot-issue@[^\]]+\])?\s+skills$/.test(line));
  if (!onlyIssueSkills) {
    throw new Error(`pnpm 待批准列表含其他包或权限，拒绝 blanket approve：${pendingLines.join('；')}`);
  }

  // pnpm 12 的具名 approve 不会清掉 tarball 形态的待批准项。只有确认列表里
  // 全部是本仓库事务 skill 后，才允许 --all；有任何其他项都在上面拒绝。
  console.log('待批准项仅为事务包 issue-workflow skill，批准该 tarball skill');
  const approved = spawnSync(bin, ['approve', '--all', '--yes'], {
    cwd: profileDir,
    env: dshEnv(dshBin),
    stdio: 'inherit',
  });
  if (approved.error) throw approved.error;
  if (approved.status !== 0) throw new Error(`pnpm approve dsh-plugin-bot-issue 失败（exit ${approved.status}）`);
}

function install(options) {
  assertNodeVersion(process.versions.node);
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const profileDir = options.profileDir || join(dshHome, 'profiles', options.profile);
  const dist = options.dist || join(repoRoot, 'dist');
  const dshBin = options.dshBin || process.env.DSH_BIN || 'dsh';
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new Error(`profile 不存在或尚未初始化：${profileDir}`);
  }
  detectDshVersion(dshBin);
  const { manifest, packages } = loadVerifiedPackages(dist);
  const buildId = manifest.stack?.buildId || `release-${Date.now()}`;
  const packagesDir = options.packagesDir || join(dshHome, 'bot', 'packages', buildId);
  const backupRoot = options.backupRoot || join(dshHome, 'bot', 'install-backups', `${Date.now()}-${buildId}`);

  console.log(`profile：${profileDir}`);
  console.log(`持久包目录：${packagesDir}`);
  console.log(`安装备份：${backupRoot}`);
  for (const item of packages) console.log(`- ${item.name}@${item.version}（SHA256 已校验）`);
  if (options.dryRun) {
    console.log('dry-run：未复制包、未修改 profile、未调用安装。');
    return;
  }

  const saved = backup(profileDir, backupRoot);
  try {
    mkdirSync(packagesDir, { recursive: true });
    for (const item of packages) {
      const target = join(packagesDir, item.filename);
      copyFileSync(join(dist, item.filename), target);
      if (sha256(target) !== item.sha256) throw new Error(`${target} 复制后 SHA256 不一致`);
      console.log(`安装 ${item.name}@${item.version}`);
      const result = spawnSync(dshBin, ['plugin', '--profile', options.profile, 'add', target, '--ignore-scripts'], {
        stdio: 'inherit',
        env: dshEnv(dshBin),
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`dsh plugin add ${item.name} 失败（exit ${result.status}）`);
    }
    activateBundles(profileDir);
    approveIssueSkills(profileDir, dshBin, options.pnpmBin);
  } catch (error) {
    try {
      restore(profileDir, backupRoot, saved);
      console.error('安装中途失败，profile 与三个 package 目录已恢复。');
    } catch (restoreError) {
      console.error(`恢复也失败：${restoreError.message}；备份在 ${backupRoot}`);
    }
    throw error;
  }

  console.log('安装与 bundle 激活完成。按原方式重启 dsh web 后生效。');
  console.log(`如需排查，安装前备份位于 ${backupRoot}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('用法：node scripts/install.mjs --profile web --dist ./dist [--dry-run] [--profile-dir DIR] [--dsh-bin PATH] [--packages-dir DIR] [--backup-root DIR]');
    } else {
      install(options);
    }
  } catch (error) {
    console.error(`安装失败：${error.message}`);
    process.exitCode = 1;
  }
}
