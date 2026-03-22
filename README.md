# WeChat Channel for Claude Code

Two-way messaging bridge between WeChat and Claude Code via the iLink Bot API.

**Background**: Tencent released [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) — a WeChat channel for [OpenClaw](https://docs.openclaw.ai). This project brings the same capability to Claude Code, following the official [Telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) and [Discord](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) channel plugin patterns.

## Features

- QR code login — scan with WeChat to connect
- Text, image, voice, file, and video message support
- Voice messages auto-transcribed (WeChat server-side STT)
- Image/file/video CDN download with AES-128-ECB decryption
- File/image/video sending via CDN upload
- Typing indicator
- Long message auto-chunking
- Poll cursor persistence (no message replay on restart)

## Prerequisites

- [Claude Code](https://claude.com/claude-code) v2.1.80+
- [Bun](https://bun.sh) runtime
- A WeChat account

## Quick Start

### 1. Install & Login (one-time)

```bash
claude --dangerously-skip-permissions
```

Inside Claude Code:

```
/plugin marketplace add jaxxjj/claude-wechat-channel
/plugin install wechat@claude-wechat-channel
/reload-plugins
/wechat:configure login
```

Scan the QR code with WeChat. Credentials saved automatically.

### 2. Start

Exit Claude Code, then:

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:wechat@claude-wechat-channel
```

Done. WeChat messages now arrive in your Claude Code session.

## How It Works

```
WeChat contact sends you a message
  → iLink Bot API (long-polling)
  → server.ts receives message
  → MCP notification to Claude Code
  → Claude processes, calls reply tool
  → server.ts sends via iLink API
  → Reply appears in WeChat
```

Access is gated by WeChat's QR code login — only contacts of the logged-in account can send messages.

## Supported Message Types

| Type | Inbound | Outbound |
|------|---------|----------|
| Text | Direct | Auto-chunked |
| Image | CDN download + AES decrypt | CDN upload + encrypt |
| Voice | Server-side speech-to-text | — |
| File (PDF, etc) | CDN download + AES decrypt | CDN upload + encrypt |
| Video | CDN download + AES decrypt | CDN upload + encrypt |

## Alternative Install Methods

### npm

```bash
npx @jaxonchenjc/claude-wechat-channel install
claude --dangerously-skip-permissions --dangerously-load-development-channels server:wechat
```

### Manual clone

```bash
git clone https://github.com/jaxxjj/claude-wechat-channel.git
cd claude-wechat-channel && bun install
```

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "wechat": {
    "command": "bun",
    "args": ["run", "--cwd", "/path/to/claude-wechat-channel", "--shell=bun", "--silent", "start"],
    "type": "stdio"
  }
}
```

## State Files

```
~/.claude/channels/wechat/
├── account.json   # Login credentials (chmod 600)
├── poll_cursor    # Long-poll cursor (prevents replay on restart)
└── inbox/         # Downloaded media files
```

## Limitations

- **Session expiry**: WeChat sessions may expire; re-run `/wechat:configure login`
- **Single session**: Only one Claude Code session can poll at a time
- **No message history**: Real-time only
- **Channels research preview**: Requires `--dangerously-load-development-channels` flag

## Credits

- WeChat iLink Bot API by Tencent
- Channel architecture inspired by [claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
- CDN encryption protocol referenced from [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)

## License

MIT
