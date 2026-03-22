#!/usr/bin/env node
/**
 * Auto-configure the WeChat MCP server in ~/.claude.json.
 *
 * Usage:
 *   npx claude-wechat-channel install
 *   npx claude-wechat-channel uninstall
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..')
const CLAUDE_JSON = join(homedir(), '.claude.json')
const SERVER_NAME = 'wechat'

const MCP_CONFIG = {
  command: 'bun',
  args: ['run', '--cwd', PLUGIN_ROOT, '--shell=bun', '--silent', 'start'],
  type: 'stdio',
}

function loadClaudeJson() {
  try {
    return JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'))
  } catch {
    return {}
  }
}

function saveClaudeJson(data) {
  writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2) + '\n')
}

const cmd = process.argv[2]

if (cmd === 'install' || !cmd) {
  const config = loadClaudeJson()
  if (!config.mcpServers) config.mcpServers = {}
  config.mcpServers[SERVER_NAME] = MCP_CONFIG
  saveClaudeJson(config)

  // Create state directory
  const stateDir = join(homedir(), '.claude', 'channels', 'wechat')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  console.log(`✅ WeChat MCP server configured in ${CLAUDE_JSON}`)
  console.log(`   Plugin root: ${PLUGIN_ROOT}`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. Start Claude Code:')
  console.log('     claude --dangerously-load-development-channels server:wechat')
  console.log('')
  console.log('  2. Log in:')
  console.log('     /wechat:configure login')
  console.log('')
  console.log('  3. Scan QR code with WeChat, restart Claude Code, done.')
} else if (cmd === 'uninstall') {
  const config = loadClaudeJson()
  if (config.mcpServers?.[SERVER_NAME]) {
    delete config.mcpServers[SERVER_NAME]
    saveClaudeJson(config)
    console.log(`✅ WeChat MCP server removed from ${CLAUDE_JSON}`)
  } else {
    console.log('WeChat MCP server not found in config.')
  }
} else {
  console.log('Usage: npx claude-wechat-channel [install|uninstall]')
  process.exit(1)
}
