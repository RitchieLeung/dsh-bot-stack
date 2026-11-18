#!/usr/bin/env node
/**
 * Patch: inject the DS Bot tool server into Codex's invocation config.
 *
 * WHY
 * dscord hands its MCP tool server to Codex by putting `mcp_servers` into the
 * `thread/start` / `thread/resume` parameters:
 *
 *   ...(mcp !== undefined ? { mcp_servers: { dsbot: { url, http_headers } } } : {}),
 *
 * Codex 0.163.0 ignores that field. Its MCP servers come only from the
 * invocation config (`~/.codex/config.toml` plus `-c` overrides); there is no
 * project-level config either (`codex doctor` reports a single config.toml, and
 * a `<cwd>/.codex/config.toml` is not read). So the server never loads and those
 * Bots get ZERO DS Bot tools: no remember/recall/contacts, and no
 * message_bot/dispatch_work, i.e. they cannot ask another member for anything.
 *
 * Evidence: the rollout of 真莹's Codex thread contains "dsbot" 0 times, while
 * Codex's own `mcp__codex_apps__*` tools appear normally.
 *
 * WHAT
 * Codex's app-server DOES accept `-c key=value` invocation-config overrides, and
 * `mcp_servers.<name>={url=..., http_headers={...}}` works there (verified with
 * `codex -c 'mcp_servers.probe_x={url="http://127.0.0.1:9/mcp"}' mcp list`).
 * ds-bot spawns one `codex app-server --listen stdio://` child per live session,
 * so the override can be built from that session's own loopback MCP url/token at
 * spawn time. Each Bot therefore gets exactly its own tool server, with no
 * global config edits and no cross-Bot leakage.
 *
 * Usage:
 *   node patches/dscord-codex-mcp.mjs [--check] [dscord-dir]
 *
 * Re-run after any dscord upgrade or reinstall.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_DSCORD = `${process.env.HOME}/.dsh/profiles/web/node_modules/dscord`
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const dir = args.find(argument => !argument.startsWith('--')) ?? DEFAULT_DSCORD
const file = path.join(dir, 'vendor', 'ds-bot', 'src', 'host', 'local-agents', 'codex.js')

const HELPER_ANCHOR = 'export class CodexEngine'
const HELPER = `// Codex 0.163.0 ignores the per-thread \`mcp_servers\` config passed to
// thread/start, and has no project-level config: MCP servers only come from the
// invocation config. Inject this session's loopback tool server as a \`-c\`
// override at spawn time. The app-server child is per live session, so each Bot
// still sees only its own server.
const processMcpArgs = mcp => (mcp?.url && mcp?.token
  ? ['-c', \`mcp_servers.dsbot={url="\${mcp.url}", http_headers={Authorization="Bearer \${mcp.token}"}}\`]
  : []);

`

const edits = [
  {
    name: 'ensure accepts extra args',
    before: '  async ensure() {',
    after: '  async ensure(extraArgs = []) {',
  },
  {
    name: 'spawn with overrides',
    before: '    const child = spawn(bin, this.engine.args ?? [], {',
    after: '    const child = spawn(bin, [...(this.engine.args ?? []), ...extraArgs], {',
  },
  {
    name: 'open passes mcp args',
    before: '    const peer = await this.ensure()\n',
    after: '    const peer = await this.ensure(processMcpArgs(mcp))\n',
  },
]

const source = readFileSync(file, 'utf8')
const pending = edits.filter(edit => !source.includes(edit.after))
const needsHelper = !source.includes('const processMcpArgs = mcp =>')

if (checkOnly) {
  if (pending.length > 0 || needsHelper) {
    const missing = [...pending.map(edit => edit.name), ...(needsHelper ? ['mcp args helper'] : [])]
    console.error(`NOT PATCHED: ${file} — missing: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log(`OK: Codex sessions get the DS Bot tool server via -c overrides`)
  process.exit(0)
}

if (pending.length === 0 && !needsHelper) {
  console.log(`Already patched: ${file}`)
  process.exit(0)
}

let next = source
for (const edit of pending) {
  if (!next.includes(edit.before)) {
    console.error(`Cannot patch ${edit.name}: anchor not found in ${file}`)
    console.error('dscord changed; re-read codex.js and update this patch.')
    process.exit(1)
  }
  next = next.replace(edit.before, edit.after)
}
if (needsHelper) {
  if (!next.includes(HELPER_ANCHOR)) {
    console.error(`Cannot patch: helper anchor not found in ${file}`)
    process.exit(1)
  }
  next = next.replace(HELPER_ANCHOR, `${HELPER}${HELPER_ANCHOR}`)
}

writeFileSync(file, next)
console.log(`Patched: ${file} (${[...pending.map(edit => edit.name), ...(needsHelper ? ['mcp args helper'] : [])].join(', ')})`)
