---
name: configure
description: Set up the WeChat channel — scan QR code to log in. Use when the user asks to configure WeChat, login, check status, or reconnect.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(curl *)
  - Bash(mkdir *)
---

# /wechat:configure — WeChat Channel Setup

Arguments passed: `$ARGUMENTS`

---

## No args — status

1. Read `~/.claude/channels/wechat/account.json`. Show logged-in or not.
2. If logged in: *"Ready. Restart Claude Code to start receiving messages."*
3. If not: *"Run `/wechat:configure login` to connect."*

## `login`

### Step 1: Get QR code

```bash
curl -s 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3'
```

Response: `{"qrcode":"<token>","qrcode_img_content":"<url>","ret":0}`

Generate a QR image URL:
`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=<url-encoded qrcode_img_content>`

Print ONLY the QR image URL. Tell the user: *"Open this link in a browser, then scan the QR code with WeChat."*

Then immediately start polling (don't wait for user to say they scanned).

IMPORTANT: In zsh, `status` is a read-only variable. Use `scan_status` or
another name when parsing the response.

```bash
for i in $(seq 1 60); do
  result=$(curl -s "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=<qrcode>")
  scan_status=$(echo "$result" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  if [ "$scan_status" = "confirmed" ]; then echo "$result"; break; fi
  if [ "$scan_status" = "expired" ]; then echo "expired"; break; fi
  sleep 3
done
```

Parse the result:
- `"status":"confirmed"` — success! Extract `bot_token`, `baseurl`
- `"status":"expired"` — tell user to run login again

### Step 3: Save credentials

```bash
mkdir -p ~/.claude/channels/wechat
```

Write `~/.claude/channels/wechat/account.json`:
```json
{
  "token": "<bot_token>",
  "baseUrl": "<baseurl>"
}
```

Then `chmod 600 ~/.claude/channels/wechat/account.json`.

Tell user:
```
✅ Logged in! Restart Claude Code with:

claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:wechat@claude-wechat-channel
```

## `logout`

Delete `~/.claude/channels/wechat/account.json`.
