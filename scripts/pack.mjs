#!/usr/bin/env node
/** Build installable tarballs without changing the source package versions. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFINITIONS = [
  { directory: 'dscord', name: 'dscord' },
  { directory: 'bot-issue', name: 'dsh-plugin-bot-issue' },
  { directory: 'bot-knowledge', name: 'dsh-plugin-bot-knowledge' },
];

function options(argv) {
  const result = {
    root: REPO_ROOT,
    out: 'dist',
    release: false,
    buildId: process.env.STACK_BUILD_ID || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--release') result.release = true;
    else if (arg === '--root') result.root = resolve(argv[++i]);
    else if (arg === '--out') result.out = argv[++i];
    else if (arg === '--build-id') result.buildId = argv[++i];
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return result;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败：\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function gitHead(root) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '.');
}

function safeBuildId(value) {
  const cleaned = String(value).replace(/[^0-9A-Za-z.-]+/g, '.').replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned) throw new Error('build id 清洗后为空');
  return cleaned;
}

function copyForPack(source, destination, outDir) {
  cpSync(source, destination, {
    recursive: true,
    filter(src) {
      const rel = relative(source, src);
      if (!rel) return true;
      const parts = rel.split(sep);
      if (parts.some(part => ['.git', 'node_modules', '.superpowers'].includes(part))) return false;
      if (resolve(src) === outDir) return false;
      return !['health.json', 'tools.json'].includes(parts.at(-1));
    },
  });
}

const opts = options(process.argv.slice(2));
if (opts.help) {
  console.log('用法：node scripts/pack.mjs [--release] [--root DIR] [--out DIR] [--build-id ID]');
  process.exit(0);
}

const root = resolve(opts.root);
const out = resolve(root, opts.out);
if (out === root || !out.startsWith(`${root}${sep}`)) {
  throw new Error(`输出目录必须是仓库内的子目录：${out}`);
}
const buildId = safeBuildId(opts.buildId || `${stamp()}.${gitHead(root).slice(0, 7)}`);
const mode = opts.release ? 'release' : 'dev';
const head = gitHead(root);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const stagingRoot = join(out, '.staging');
mkdirSync(stagingRoot);

const packages = [];
for (const definition of DEFINITIONS) {
  const source = join(root, definition.directory);
  const manifestPath = join(source, 'package.json');
  if (!existsSync(manifestPath)) throw new Error(`缺少 ${manifestPath}`);
  const sourceManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (sourceManifest.name !== definition.name) {
    throw new Error(`${definition.directory} 的包名应为 ${definition.name}，实际为 ${sourceManifest.name}`);
  }

  const staging = join(stagingRoot, definition.directory);
  copyForPack(source, staging, out);
  const baseVersion = sourceManifest.version;
  const version = opts.release ? baseVersion : `${baseVersion}-dev.${buildId}`;
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ ...sourceManifest, version }, null, 2)}\n`);

  const output = run('npm', ['pack', staging, '--pack-destination', out, '--json'], root);
  const report = JSON.parse(output)[0];
  const filename = report.filename || report.name;
  const file = join(out, filename);
  if (!existsSync(file)) throw new Error(`npm pack 没有生成 ${file}`);
  const buffer = readFileSync(file);
  packages.push({
    directory: definition.directory,
    name: definition.name,
    baseVersion,
    version,
    filename,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: statSync(file).size,
  });
}

rmSync(stagingRoot, { recursive: true, force: true });
const manifest = {
  stack: { head, buildId, mode, generatedAt: new Date().toISOString() },
  packages,
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, 'SHA256SUMS'), `${packages.map(pkg => `${pkg.sha256}  ${pkg.filename}`).join('\n')}\n`);

console.log(`已生成 ${packages.length} 个安装包（${mode}，build ${buildId}）：`);
for (const pkg of packages) console.log(`- ${pkg.name}@${pkg.version}  ${pkg.filename}`);
