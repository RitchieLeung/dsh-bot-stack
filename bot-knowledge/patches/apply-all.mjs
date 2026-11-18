#!/usr/bin/env node
/**
 * One entry point for every dscord patch this project relies on.
 *
 * `node patches/apply-all.mjs --check`   → exit 1 if any patch is missing
 * `node patches/apply-all.mjs`           → apply every missing patch (idempotent)
 * `node patches/apply-all.mjs --list`    → what each patch does
 *
 * Run `--check` after anything that can rewrite node_modules: a dscord upgrade,
 * a reinstall, `pnpm install`, or adding/removing a profile plugin (the plugin
 * manager runs pnpm, which may unpack the dscord tarball again).
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const mode = process.argv.includes('--check') ? ['--check'] : []
const listOnly = process.argv.includes('--list')

const PATCHES = [
  {
    script: 'dscord-memory-session.mjs',
    what: '记忆审查：用独立会话 + 改用 API 模型，修复 codex/claude/ACP 路由 Bot 写不了记忆',
  },
  {
    script: 'dscord-codex-mcp.mjs',
    what: 'Codex 工具注入：未采用。Codex 与 dscord 的进程模型冲突，仅在需要时手动评估',
    optional: true,
  },
]

if (listOnly) {
  for (const patch of PATCHES) console.log(`${patch.optional ? '[可选]' : '[必需]'} ${patch.script}\n    ${patch.what}`)
  process.exit(0)
}

let failed = 0
for (const patch of PATCHES) {
  if (patch.optional && mode.length > 0) {
    // Optional patches are reported but never fail the check on their own.
    const result = spawnSync(process.execPath, [path.join(here, patch.script), ...mode], { encoding: 'utf8' })
    const state = result.status === 0 ? 'applied' : 'not applied'
    console.log(`[可选] ${patch.script}: ${state}`)
    continue
  }
  const result = spawnSync(process.execPath, [path.join(here, patch.script), ...mode], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  console.log(`${result.status === 0 ? '✓' : '✗'} ${patch.script}`)
  if (output) console.log(output.split('\n').map(line => `    ${line}`).join('\n'))
  if (result.status !== 0) failed += 1
}

if (mode.length > 0) {
  if (failed > 0) {
    console.error(`\n${failed} 个必需补丁缺失。运行 node patches/apply-all.mjs 重放。`)
    process.exit(1)
  }
  console.log('\n所有必需补丁都已应用。')
}
