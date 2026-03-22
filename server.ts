#!/usr/bin/env bun
/**
 * WeChat channel for Claude Code.
 *
 * Self-contained MCP server. Access is gated by WeChat's QR code login —
 * only contacts of the logged-in account can send messages. No separate
 * pairing or allowlist needed (unlike Telegram/Discord bots).
 *
 * State lives in ~/.claude/channels/wechat/.
 * Uses the iLink Bot API for WeChat messaging (long-polling + HTTP).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import {
  chmodSync, mkdirSync, readFileSync,
  realpathSync, statSync, writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, extname, join, sep } from 'path'

// ---------------------------------------------------------------------------
// State directories & env loading
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.WECHAT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'wechat')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCOUNT_FILE = join(STATE_DIR, 'account.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const CURSOR_FILE = join(STATE_DIR, 'poll_cursor')

// Load .env — plugin-spawned servers don't get an env block.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// Last-resort safety net — keep the process alive on unhandled errors.
process.on('unhandledRejection', err => {
  process.stderr.write(`wechat channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`wechat channel: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// iLink Bot API — WeChat HTTP protocol
// ---------------------------------------------------------------------------

interface WechatAccount {
  token: string
  baseUrl: string
  cdnBaseUrl?: string
  userId?: string
}

interface WechatMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number  // 1=USER, 2=BOT
  message_state?: number // 0=NEW, 1=GENERATING, 2=FINISH
  item_list?: MessageItem[]
  context_token?: string
}

interface MessageItem {
  type: number  // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: { text: string }
  image_item?: { media?: CdnMedia; aeskey?: string }
  voice_item?: { media?: CdnMedia; text?: string }
  file_item?: { media?: CdnMedia; file_name?: string }
  video_item?: { media?: CdnMedia }
}

interface CdnMedia {
  encrypt_query_param?: string
  aes_key?: string
}

function loadAccount(): WechatAccount | null {
  try {
    return JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'))
  } catch {
    return null
  }
}

function apiHeaders(token: string): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64')
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${token}`,
    'X-WECHAT-UIN': uin,
  }
}

async function apiCall(baseUrl: string, endpoint: string, body: unknown, token: string, timeoutMs = 40000): Promise<unknown> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const url = new URL(endpoint, base).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: apiHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text}`)
    }
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Context token management — WeChat requires echoing context_token in replies
// In-memory cache as fallback; primary source is the tool parameter from Claude.
// ---------------------------------------------------------------------------

const contextTokens = new Map<string, string>()

function setContextToken(userId: string, token: string): void {
  contextTokens.set(userId, token)
}

function getContextToken(userId: string): string | undefined {
  return contextTokens.get(userId)
}

function resolveContextToken(explicit: string | undefined, userId: string): string {
  const token = explicit || getContextToken(userId)
  if (!token) throw new Error(`No context_token for ${userId} — the user must message first`)
  return token
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

async function sendTyping(account: WechatAccount, userId: string, status: 1 | 2 = 1): Promise<void> {
  try {
    const configRes = await apiCall(account.baseUrl, 'ilink/bot/getconfig', {
      ilink_user_id: userId,
      context_token: getContextToken(userId),
    }, account.token, 10000) as Record<string, unknown>

    const typingTicket = configRes.typing_ticket as string | undefined
    if (!typingTicket) return

    await apiCall(account.baseUrl, 'ilink/bot/sendtyping', {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
    }, account.token, 10000)
  } catch {
    // Typing is best-effort — swallow errors.
  }
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

async function sendMessage(account: WechatAccount, toUserId: string, text: string, explicitContextToken?: string): Promise<{ messageId: string }> {
  const contextToken = resolveContextToken(explicitContextToken, toUserId)

  const clientId = `claude-wechat-${randomBytes(8).toString('hex')}`
  const res = await apiCall(account.baseUrl, 'ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      context_token: contextToken,
      message_type: 2,  // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: '1.0.2' },
  }, account.token) as Record<string, unknown>

  return { messageId: String(res.message_id ?? clientId) }
}

// ---------------------------------------------------------------------------
// CDN — AES-128-ECB crypto + upload/download
// Aligned with @tencent-weixin/openclaw-weixin cdn/ module.
// ---------------------------------------------------------------------------

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const MAX_CHUNK_LIMIT = 4000

/** Encrypt buffer with AES-128-ECB (PKCS7 padding). */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)           → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`${label}: aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`)
}

/** Build a CDN download URL from encrypt_query_param. */
function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

/** Build a CDN upload URL from upload_param and filekey. */
function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

/** Download raw bytes from the CDN. */
async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText} ${body}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/** Download and AES-128-ECB decrypt a CDN media file. */
async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label)
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
  const encrypted = await fetchCdnBytes(url, label)
  return decryptAesEcb(encrypted, key)
}

/** Download plain (unencrypted) bytes from the CDN. */
async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
  return fetchCdnBytes(url, label)
}

/**
 * Upload one buffer to the WeChat CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 */
async function uploadBufferToCdn(params: {
  buf: Buffer
  uploadParam: string
  filekey: string
  cdnBaseUrl: string
  label: string
  aeskey: Buffer
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey)
  const cdnUrl = buildCdnUploadUrl(params.cdnBaseUrl, params.uploadParam, params.filekey)
  const res = await fetch(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  })
  if (!res.ok) {
    const errMsg = await res.text().catch(() => `status ${res.status}`)
    throw new Error(`${params.label}: CDN upload failed: ${errMsg}`)
  }
  const downloadParam = res.headers.get('x-encrypted-param')
  if (!downloadParam) {
    throw new Error(`${params.label}: CDN response missing x-encrypted-param header`)
  }
  return { downloadParam }
}

/**
 * Download a media item to local inbox. Returns local file path.
 * Handles image_item.aeskey (hex) vs media.aes_key (base64) per SDK.
 */
async function downloadMediaToInbox(
  cdnMedia: CdnMedia,
  cdnBaseUrl: string,
  ext: string,
  label: string,
  hexAesKey?: string,
): Promise<string | undefined> {
  if (!cdnMedia.encrypt_query_param) return undefined
  // Images may have aeskey as hex string separate from media.aes_key (base64)
  const aesKeyBase64 = hexAesKey
    ? Buffer.from(hexAesKey, 'hex').toString('base64')
    : cdnMedia.aes_key
  try {
    const buf = aesKeyBase64
      ? await downloadAndDecryptBuffer(cdnMedia.encrypt_query_param, aesKeyBase64, cdnBaseUrl, label)
      : await downloadPlainCdnBuffer(cdnMedia.encrypt_query_param, cdnBaseUrl, label)
    mkdirSync(INBOX_DIR, { recursive: true })
    const filePath = join(INBOX_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`)
    writeFileSync(filePath, buf)
    process.stderr.write(`${label}: saved ${filePath} (${buf.length} bytes)\n`)
    return filePath
  } catch (err) {
    process.stderr.write(`${label}: download failed: ${err}\n`)
    return undefined
  }
}

function inferMediaType(filePath: string): number {
  const ext = extname(filePath).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 1
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 2
  return 3
}

/**
 * Upload a local file to WeChat CDN and send it as a message.
 * Pipeline: read → hash → gen AES key → getuploadurl → encrypt+upload → sendmessage
 */
async function sendFileMessage(
  account: WechatAccount,
  toUserId: string,
  filePath: string,
  explicitContextToken?: string,
): Promise<{ messageId: string }> {
  const contextToken = resolveContextToken(explicitContextToken, toUserId)

  const plaintext = readFileSync(filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)
  const mediaType = inferMediaType(filePath)
  const cdnBaseUrl = account.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL
  const fileName = basename(filePath)
  const label = `sendFile[${fileName}]`

  // Step 1: Get upload URL
  const uploadRes = await apiCall(account.baseUrl, 'ilink/bot/getuploadurl', {
    filekey, media_type: mediaType, to_user_id: toUserId,
    rawsize, rawfilemd5, filesize,
  }, account.token) as Record<string, unknown>

  const uploadParam = uploadRes.upload_param as string | undefined
  if (!uploadParam) throw new Error(`${label}: getuploadurl returned no upload_param`)

  // Step 2: Encrypt and upload to CDN
  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext, uploadParam, filekey, cdnBaseUrl, aeskey, label,
  })

  // Step 3: Build media item and send
  const aesKeyBase64 = aeskey.toString('base64')
  const cdnMedia = { encrypt_query_param: downloadParam, aes_key: aesKeyBase64 }

  let mediaItem: Record<string, unknown>
  if (mediaType === 1) {
    mediaItem = { type: 2, image_item: { media: cdnMedia, mid_size: filesize } }
  } else if (mediaType === 2) {
    mediaItem = { type: 5, video_item: { media: cdnMedia, video_size: filesize } }
  } else {
    mediaItem = { type: 4, file_item: { media: cdnMedia, file_name: fileName, len: String(rawsize) } }
  }

  const itemClientId = `claude-wechat-${randomBytes(8).toString('hex')}`
  const res = await apiCall(account.baseUrl, 'ilink/bot/sendmessage', {
    msg: {
      from_user_id: '', to_user_id: toUserId, client_id: itemClientId,
      context_token: contextToken, message_type: 2, message_state: 2,
      item_list: [mediaItem],
    },
    base_info: { channel_version: '1.0.2' },
  }, account.token) as Record<string, unknown>

  return { messageId: String(res.message_id ?? itemClientId) }
}

// Refuse to send channel state files (except inbox).
function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---------------------------------------------------------------------------
// Extract text from WeChat message items
// ---------------------------------------------------------------------------

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>[\]\r\n;]/g, '_')
}

function extractText(msg: WechatMessage): string {
  if (!msg.item_list || msg.item_list.length === 0) return ''
  const parts: string[] = []
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text)
    } else if (item.type === 2) {
      parts.push('(image)')
    } else if (item.type === 3) {
      if (item.voice_item?.text) {
        parts.push(item.voice_item.text)
      } else {
        parts.push('(voice)')
      }
    } else if (item.type === 4) {
      const name = safeName(item.file_item?.file_name) ?? 'unknown'
      parts.push(`(file: ${name})`)
    } else if (item.type === 5) {
      parts.push('(video)')
    }
  }
  return parts.join('\n') || ''
}

// ---------------------------------------------------------------------------
// MCP Server — channel declaration + tools
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'wechat', version: '1.0.2' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The sender reads WeChat, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
      '',
      'Messages from WeChat arrive as <channel source="wechat" chat_id="..." context_token="..." message_id="..." user="..." ts="...">. If the tag has image_path or attachment_path, use the Read tool directly on that path. NEVER install or use external tools like poppler, python-docx, or pdftotext — the Read tool handles images, PDFs, and common file formats natively. Reply with the reply tool — pass chat_id and context_token back. The context_token is REQUIRED for delivery.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Images send as photos; videos as video messages; other types as file attachments.',
      '',
      'WeChat has no history or search API — you only see messages as they arrive. If you need earlier context, ask the user to paste it or summarize.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply on WeChat. Pass chat_id and context_token from the inbound message. context_token is required for delivery.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'WeChat user ID from the inbound <channel> tag' },
          text: { type: 'string', description: 'Message text to send' },
          context_token: { type: 'string', description: 'context_token from the inbound <channel> tag. Required for delivery.' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths to attach. Images send as photos; videos as video messages; others as file attachments. Max 50MB each.',
          },
        },
        required: ['chat_id', 'text', 'context_token'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const account = loadAccount()
  if (!account) {
    return {
      content: [{ type: 'text', text: 'WeChat not configured. Run /wechat:configure to log in.' }],
      isError: true,
    }
  }

  try {
    switch (req.params.name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const ct = args.context_token as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const chunks = chunk(text, MAX_CHUNK_LIMIT)
        const sentIds: string[] = []

        await sendTyping(account, chat_id, 2).catch(() => {})

        try {
          for (const c of chunks) {
            const result = await sendMessage(account, chat_id, c, ct)
            sentIds.push(result.messageId)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        for (const f of files) {
          const result = await sendFileMessage(account, chat_id, f, ct)
          sentIds.push(result.messageId)
        }

        const result = sentIds.length === 1
          ? `sent (id: ${sentIds[0]})`
          : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ---------------------------------------------------------------------------
// Connect MCP over stdio
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('wechat channel: shutting down\n')
  setTimeout(() => process.exit(0), 2000)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ---------------------------------------------------------------------------
// Long-polling loop — getupdates
// ---------------------------------------------------------------------------

void (async () => {
  const account = loadAccount()
  if (!account) {
    process.stderr.write(
      `wechat channel: not logged in\n` +
      `  run /wechat:configure to scan QR code and log in\n`,
    )
    return
  }

  process.stderr.write(`wechat channel: starting message polling\n`)

  // Load persisted poll cursor — prevents message replay on restart
  let cursor = ''
  try {
    cursor = readFileSync(CURSOR_FILE, 'utf8').trim()
    process.stderr.write(`wechat channel: resumed poll cursor (${cursor.length} bytes)\n`)
  } catch {}

  for (let attempt = 1; !shuttingDown; ) {
    try {
      const res = await apiCall(account.baseUrl, 'ilink/bot/getupdates', {
        get_updates_buf: cursor,
      }, account.token, 40000) as Record<string, unknown>

      const errcode = res.errcode as number | undefined
      if (errcode === -14) {
        process.stderr.write('wechat channel: session expired (errcode -14). Run /wechat:configure to re-login.\n')
        return
      }

      if (res.ret !== 0 && res.ret !== undefined) {
        process.stderr.write(`wechat channel: getupdates returned ret=${res.ret} errmsg=${res.errmsg ?? ''}\n`)
        await new Promise(r => setTimeout(r, 5000))
        continue
      }

      if (res.get_updates_buf) {
        cursor = res.get_updates_buf as string
        try {
          mkdirSync(STATE_DIR, { recursive: true })
          writeFileSync(CURSOR_FILE, cursor)
        } catch {}
      }

      const msgs = (res.msgs ?? []) as WechatMessage[]
      attempt = 1

      for (const msg of msgs) {
        if (msg.message_type !== 1) continue  // skip BOT echoes
        if (msg.message_state === 1) continue // skip GENERATING

        const senderId = msg.from_user_id
        if (!senderId) continue

        if (msg.context_token) setContextToken(senderId, msg.context_token)

        const text = extractText(msg)
        if (!text) continue

        const ts = msg.create_time_ms
          ? new Date(msg.create_time_ms).toISOString()
          : new Date().toISOString()

        void sendTyping(account, senderId, 1).catch(() => {})

        // Download media — defer until after we know the message is valid
        const cdnBaseUrl = account.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL
        let imagePath: string | undefined
        let attachmentPath: string | undefined
        let attachmentName: string | undefined
        if (msg.item_list) {
          for (const item of msg.item_list) {
            if (item.type === 2 && item.image_item?.media) {
              imagePath = await downloadMediaToInbox(item.image_item.media, cdnBaseUrl, 'jpg', 'inbound image', item.image_item.aeskey)
            } else if (item.type === 4 && item.file_item?.media) {
              const fname = item.file_item.file_name ?? 'file'
              const ext = fname.includes('.') ? fname.split('.').pop()! : 'bin'
              attachmentPath = await downloadMediaToInbox(item.file_item.media, cdnBaseUrl, ext, `inbound file[${fname}]`)
              attachmentName = safeName(fname)
            } else if (item.type === 5 && item.video_item?.media) {
              attachmentPath = await downloadMediaToInbox(item.video_item.media, cdnBaseUrl, 'mp4', 'inbound video')
              attachmentName = 'video.mp4'
            }
          }
        }

        const meta: Record<string, string> = {
          chat_id: senderId,
          user: senderId,
          user_id: senderId,
          ts,
        }
        if (msg.context_token) meta.context_token = msg.context_token
        if (msg.message_id != null) meta.message_id = String(msg.message_id)
        if (imagePath) meta.image_path = imagePath
        if (attachmentPath) meta.attachment_path = attachmentPath
        if (attachmentName) meta.attachment_name = attachmentName

        mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: text, meta },
        }).catch(err => {
          process.stderr.write(`wechat channel: failed to deliver inbound to Claude: ${err}\n`)
        })
      }
    } catch (err) {
      if (shuttingDown) break
      const delay = Math.min(1000 * attempt, 15000)
      process.stderr.write(`wechat channel: polling error: ${err}, retrying in ${delay / 1000}s\n`)
      await new Promise(r => setTimeout(r, delay))
      attempt++
    }
  }
})()
