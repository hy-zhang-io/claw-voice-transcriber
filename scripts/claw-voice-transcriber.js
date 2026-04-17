#!/usr/bin/env node
/**
 * Voice Transcriber: Audio file → text via OpenAI-compatible ASR API
 *
 * Config priority (highest → lowest):
 *   1. <agentDir>/claw-voice-transcriber.json  (per-agent override)
 *   2. <workspace>/config/claw-voice-transcriber.json  (workspace override)
 *   3. openclaw.json models.providers (type: "asr") + prefs file
 *   4. Environment variables (ASR_API_KEY, ASR_BASE_URL, ASR_MODEL)
 *
 * Config format supports multiple providers with primary + fallback:
 * {
 *   "primaryProvider": "alibaba-qwen",
 *   "fallbackProvider": "openai-whisper",
 *   "providers": {
 *     "alibaba-qwen": {
 *       "apiKey": "${ASR_ALIBABA_API_KEY}",
 *       "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
 *       "model": "qwen3-asr-flash",
 *       "style": "qwen"
 *     }
 *   }
 * }
 *
 * Legacy flat format also supported:
 * { "apiKey": "...", "baseUrl": "...", "model": "...", "style": "..." }
 *
 * Usage:
 *   node claw-voice-transcriber.js <audio_file_path_or_url> [--archive]
 *
 * Output: recognized text to stdout (JSON on error)
 * Requirements: node >= 18, no external dependencies
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;

// --- Globals ---
const HOME_DIR = process.env.HOME || os.homedir();
// Optional base directory restriction for local file access (empty = unrestricted)
const ALLOWED_BASE_DIRS = [];

// --- Constants ---
const MAX_REDIRECTS = 5;                          // Max HTTP redirect hops
const MAX_FILE_BYTES = 100 * 1024 * 1024;         // 100MB max local file size
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;     // 100MB max URL download size
const REQUEST_TIMEOUT_MS = 30000;                  // 30s per HTTP request
const USER_AGENT = 'OpenClaw-voice-transcriber/1.0';

// Supported audio MIME types (by file extension)
const AUDIO_MIME_MAP = {
  ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', flac: 'audio/flac', webm: 'audio/webm', opus: 'audio/opus'
};

// Allowed audio file extensions
const ALLOWED_EXTENSIONS = new Set(Object.keys(AUDIO_MIME_MAP));

// Safe MIME types whitelist (prevents header injection)
const SAFE_MIME_TYPES = new Set(Object.values(AUDIO_MIME_MAP));

// Valid agent ID pattern (alphanumeric, hyphens, underscores)
const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// --- Defaults ---
// Style constants
const STYLE_QWEN = 'qwen';
const STYLE_OPENAI = 'openai';

const DEFAULTS = {
  defaultProvider: {
    apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash', style: STYLE_QWEN
  }
};

// --- Utility functions ---

/** Resolve ${ENV_VAR} references recursively in strings and objects */
function resolveEnvRefs(obj) {
  if (typeof obj === 'string') return obj.replace(/\$\{([^}]+)\}/g, (_, k) => {
    if (!(k in process.env)) process.stderr.write(`Warning: env var $${k} is not set\n`);
    return process.env[k] || '';
  });
  if (Array.isArray(obj)) return obj.map(resolveEnvRefs);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveEnvRefs(v);
    return out;
  }
  return obj;
}

/**
 * Load and parse a JSON file.
 * @param {string} filePath - Path to JSON file
 * @returns {object|null} Parsed JSON or null on ENOENT
 */
function loadJson(filePath) {
  try {
    let raw = fs.readFileSync(filePath, 'utf8');
    // Strip JSON5 features for compatibility (comments, trailing commas)
    raw = raw.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, '');
    raw = raw.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    const safeName = path.basename(filePath);
    if (e.code === 'EACCES') process.stderr.write(`Warning: permission denied reading ${safeName}\n`);
    else if (e instanceof SyntaxError) process.stderr.write(`Warning: invalid JSON in ${safeName}\n`);
    else process.stderr.write(`Warning: failed to read ${safeName}: ${e.message}\n`);
    return null;
  }
}

/** Sanitize filename: remove path components, CRLF, unicode control chars, and zero-width chars */
function sanitizeFilename(name) {
  const base = path.basename(name);
  // Remove CRLF, ASCII control chars, unicode line/paragraph separators,
  // bidirectional overrides, zero-width chars, quotes, backslashes, and other unicode control chars
  return base
    .replace(/[\r\n\x00-\x1f\x7f\u0080-\u009f\u2028\u2029\u202A-\u202E\u200B-\u200D\uFEFF"\\]/g, '')
    .trim() || 'audio';
}

/**
 * Validate MIME type against whitelist.
 * @param {string} mime - MIME type string
 * @returns {string} Safe MIME type or fallback
 */
function safeMimeType(mime) {
  return SAFE_MIME_TYPES.has(mime) ? mime : 'audio/wav';
}

/**
 * Validate and resolve a local file path.
 * Uses lstat first to detect symlinks, then stat for size (minimize TOCTOU window).
 * @param {string} filePath - File path to validate
 * @returns {{ resolved: string, ext: string, size: number }}
 */
function validateLocalFile(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).slice(1).toLowerCase();

  // Check optional base directory restrictions
  if (ALLOWED_BASE_DIRS.length > 0) {
    const underAllowed = ALLOWED_BASE_DIRS.some(dir => resolved.startsWith(path.resolve(dir) + path.sep));
    if (!underAllowed) throw new Error(`File path is outside allowed directories: ${path.basename(resolved)}`);
  }

  // Use lstat first to detect symlinks, then stat for size (minimize TOCTOU window)
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`File not found: ${path.basename(resolved)}`);
    throw new Error(`Cannot access file: ${path.basename(resolved)}`);
  }

  // Reject symlinks
  if (stat.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed: ${path.basename(resolved)}`);
  }

  // For non-symlinks, lstat gives the real file info — get size directly
  // Reject directories
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${path.basename(resolved)}`);
  }

  // Check file extension
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported audio format: .${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
  }

  // Check file size
  if (stat.size === 0) throw new Error(`File is empty: ${path.basename(resolved)}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`);
  }

  return { resolved, ext, size: stat.size };
}

/**
 * Check if an IP address is private/internal.
 * Handles decimal, hex, and octal IP formats by parsing through Node's URL + DNS.
 * @param {string} hostname - Hostname to check
 * @returns {Promise<boolean>} True if hostname resolves to a private IP
 */
async function isPrivateHost(hostname) {
  // Check string patterns first (fast path)
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '[::1]' || lower === '[::0]' || lower === '[::ffff:127.0.0.1]') {
    return true;
  }

  // Check standard private IP ranges via regex
  const PRIVATE_IP_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/;
  if (PRIVATE_IP_RE.test(hostname)) {
    return true;
  }

  // DNS resolution — check both A and AAAA records (prevents IPv6 SSRF bypass)
  try {
    const [a4, a6] = await Promise.race([
      Promise.all([
        dns.resolve4(hostname).catch(() => []),
        dns.resolve6(hostname).catch(() => [])
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000))
    ]);
    for (const addr of a4) {
      if (isPrivateIpString(addr)) return true;
    }
    for (const addr of a6) {
      if (isPrivateIpString(addr)) return true;
    }
  } catch {
    // DNS resolution failed - if it looks like a raw IP (numeric), try to parse it
    if (/^\d+$/.test(hostname)) {
      const num = parseInt(hostname, 10);
      if (!isNaN(num)) {
        const a = (num >>> 24) & 0xff, b = (num >>> 16) & 0xff;
        if (arePrivateOctets(a, b)) return true;
      }
    }
    // Hex IP: 0x7f000001
    if (/^0x[0-9a-f]+$/i.test(hostname)) {
      const num = parseInt(hostname, 16);
      if (!isNaN(num)) {
        const a = (num >>> 24) & 0xff, b = (num >>> 16) & 0xff;
        if (arePrivateOctets(a, b)) return true;
      }
    }
    // Octal IP: 0177.0.0.1
    if (/^0[0-7]+/.test(hostname)) {
      try {
        const parts = hostname.split('.');
        if (parts.length === 4 && parts.every(p => /^0?[0-7]+$/.test(p))) {
          const octets = parts.map(p => parseInt(p, 8));
          if (arePrivateOctets(octets[0], octets[1])) return true;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return false;
}

/** Check if first two octets of an IPv4 address indicate a private range */
function arePrivateOctets(a, b) {
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Check if a resolved IP string (IPv4 or IPv6) is in a private range */
function isPrivateIpString(ip) {
  // IPv4 private ranges
  if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (ip.startsWith('::ffff:')) return isPrivateIpString(ip.slice(7));
  // IPv6 loopback
  if (ip === '::1' || ip === '::') return true;
  // IPv6 unique local (fc00::/7)
  if (/^f[cde][0-9a-f]{2}:/i.test(ip)) return true;
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  // IPv4-compatible IPv6 ::127.0.0.1 etc
  if (/^::(127\.|10\.|0\.0?\.0?\.)/.test(ip)) return true;
  // IPv6 discard prefix (100::/64)
  if (/^100::/i.test(ip)) return true;
  return false;
}

// DNS lookup cache to prevent DNS rebinding (hostname -> lookup function)
const dnsLookupCache = new Map();

/** Resolve hostname and return a lookup function that pins the cached address */
async function cacheDnsLookup(hostname) {
  if (dnsLookupCache.has(hostname)) return dnsLookupCache.get(hostname);
  const lookupFn = (hostname2, opts, cb) => {
    const cached = dnsLookupCache.get(hostname2);
    if (cached) {
      const entry = cached._addrs[0];
      return cb(null, entry.address, entry.family);
    }
    // Fallback to default resolution
    dns.lookup(hostname2, opts, cb);
  };
  const addrs = await dns.lookup(hostname, { all: true });
  lookupFn._addrs = addrs;
  dnsLookupCache.set(hostname, lookupFn);
  return lookupFn;
}

/**
 * Validate a URL for safe HTTP(S) access.
 * Blocks private IPs (including hex/octal/decimal formats) and non-HTTP protocols.
 * @param {string} url - URL to validate
 * @returns {Promise<{ parsed: URL, lookupFn: Function }>} Parsed URL and pinned lookup function
 */
async function validateUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http/https allowed.`);
  }
  if (await isPrivateHost(parsed.hostname)) {
    throw new Error(`Access to internal/private addresses is blocked: ${parsed.hostname}`);
  }
  // Resolve and cache DNS to prevent DNS rebinding
  const lookupFn = await cacheDnsLookup(parsed.hostname);
  return { parsed, lookupFn };
}

/**
 * Validate resolved config values.
 * @param {object} cfg - Config object to validate
 */
function validateConfig(cfg) {
  if (!cfg.apiKey || typeof cfg.apiKey !== 'string') {
    throw new Error('ASR_API_KEY is required and must be a non-empty string.');
  }
  if (!cfg.baseUrl || typeof cfg.baseUrl !== 'string') {
    throw new Error('ASR_BASE_URL is required and must be a valid URL string.');
  }
  if (!cfg.model || typeof cfg.model !== 'string') {
    throw new Error('ASR_MODEL is required and must be a non-empty string.');
  }
  if (![STYLE_QWEN, STYLE_OPENAI].includes(cfg.style)) {
    throw new Error(`Invalid style: "${cfg.style}". Must be "${STYLE_QWEN}" or "${STYLE_OPENAI}".`);
  }
  if (cfg.fallback) validateConfig(cfg.fallback);
}

// --- Config resolution ---

/**
 * Resolve ASR config from openclaw.json models.providers.
 * Discovers providers with type: "asr" models, applies prefs if available.
 * @returns {object|null} Config {apiKey, baseUrl, model, style} or null
 */
function resolveConfigFromOpenClaw() {
  const ocJson = loadJson(path.join(HOME_DIR, '.openclaw', 'openclaw.json'));
  if (!ocJson || !ocJson.models || !ocJson.models.providers) return null;

  // Load preferences (optional)
  const prefs = loadJson(path.join(
    HOME_DIR, '.openclaw', 'config', 'claw-voice-transcriber-prefs.json'
  )) || {};

  // Collect all ASR models across providers
  const asrModels = [];
  for (const [providerName, provider] of Object.entries(ocJson.models.providers)) {
    if (!provider || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (model.type === 'asr') {
        asrModels.push({ providerName, provider, model });
      }
    }
  }

  if (asrModels.length === 0) return null;

  // Select target: use prefs if available, otherwise first ASR model
  let target;
  if (prefs.activeProvider && prefs.activeModel) {
    target = asrModels.find(
      m => m.providerName === prefs.activeProvider && m.model.id === prefs.activeModel
    );
  }
  if (!target) target = asrModels[0];

  const { provider, model } = target;

  // Determine style: provider.api sets base, provider.asrStyle overrides, model.asrStyle wins
  let style = STYLE_OPENAI; // default
  if (provider.api === 'openai-completions') {
    style = STYLE_QWEN;
  }
  if (provider.asrStyle) style = provider.asrStyle;
  if (model.asrStyle) style = model.asrStyle;

  // Infer style from baseUrl as last resort
  if (style === STYLE_OPENAI && provider.baseUrl && provider.baseUrl.includes('dashscope')) {
    style = STYLE_QWEN;
  }

  return {
    apiKey: provider.apiKey || '',
    baseUrl: (provider.baseUrl || '').replace(/\/+$/, ''),
    model: model.id || '',
    style
  };
}

function resolveConfig() {
  // Env vars (used as fallbacks within config resolution)
  const envKey = process.env.ASR_API_KEY || '';
  const envUrl = process.env.ASR_BASE_URL || '';
  const envModel = process.env.ASR_MODEL || '';
  const envStyle = process.env.ASR_STYLE || '';

  // Workspace config
  const wsCfg = loadJson(path.join(process.cwd(), 'config', 'claw-voice-transcriber.json'));

  // Agent config (highest priority) — validate agentId to prevent path traversal
  const agentId = process.env.OPENCLAW_AGENT_ID || '';
  let agentCfg = null;
  if (agentId) {
    if (!AGENT_ID_PATTERN.test(agentId)) {
      process.stderr.write(`Warning: invalid OPENCLAW_AGENT_ID format, skipping agent config\n`);
    } else {
      agentCfg = loadJson(path.join(
        HOME_DIR, '.openclaw', 'agents', agentId, 'agent', 'claw-voice-transcriber.json'
      ));
    }
  }

  // Use highest-priority config (resolve ${ENV_VAR} refs)
  const cfg = resolveEnvRefs(agentCfg || wsCfg || null);

  if (cfg && cfg.providers) {
    const primary = cfg.primaryProvider || Object.keys(cfg.providers)[0] || 'alibaba-qwen';
    const fallback = cfg.fallbackProvider || null;
    const provider = cfg.providers[primary] || DEFAULTS.defaultProvider;
    const fallbackProvider = fallback ? (cfg.providers[fallback] || null) : null;
    return {
      apiKey: provider.apiKey || envKey,
      baseUrl: (provider.baseUrl || envUrl).replace(/\/+$/, ''),
      model: provider.model || envModel || DEFAULTS.defaultProvider.model,
      style: provider.style || envStyle || STYLE_QWEN,
      fallback: fallbackProvider ? {
        apiKey: fallbackProvider.apiKey || envKey,
        baseUrl: (fallbackProvider.baseUrl || envUrl).replace(/\/+$/, ''),
        model: fallbackProvider.model || envModel || 'whisper-1',
        style: fallbackProvider.style || envStyle || STYLE_OPENAI,
      } : null
    };
  }

  // Flat config from agent/workspace (legacy or simple)
  if (cfg && (cfg.apiKey || cfg.baseUrl || cfg.model)) {
    const flat = cfg;
    const fallbackUrl = flat.baseUrl || envUrl || DEFAULTS.defaultProvider.baseUrl;
    let style = flat.style || envStyle;
    if (!style) style = fallbackUrl.includes('dashscope') ? STYLE_QWEN : STYLE_OPENAI;
    return {
      apiKey: flat.apiKey || envKey,
      baseUrl: fallbackUrl.replace(/\/+$/, ''),
      model: flat.model || envModel || DEFAULTS.defaultProvider.model,
      style,
      fallback: null
    };
  }

  // Try openclaw.json models.providers (ASR model discovery)
  const ocCfg = resolveConfigFromOpenClaw();
  if (ocCfg) {
    return {
      apiKey: ocCfg.apiKey || envKey,
      baseUrl: ocCfg.baseUrl || envUrl || DEFAULTS.defaultProvider.baseUrl,
      model: ocCfg.model || envModel || DEFAULTS.defaultProvider.model,
      style: ocCfg.style || envStyle || STYLE_QWEN,
      fallback: null
    };
  }

  // Final fallback: env vars
  return {
    apiKey: envKey,
    baseUrl: (envUrl || DEFAULTS.defaultProvider.baseUrl).replace(/\/+$/, ''),
    model: envModel || DEFAULTS.defaultProvider.model,
    style: envStyle || STYLE_QWEN,
    fallback: null
  };
}

// --- Load and validate config ---
const config = resolveConfig();

try {
  validateConfig(config);
} catch (e) {
  process.stderr.write(`Config error: ${e.message}\n`);
  process.stderr.write('Set ASR_API_KEY in openclaw.json skills.entries.claw-voice-transcriber.env\n');
  process.exit(1);
}

// --- Archive directory ---
const ARCHIVE_DIR = process.env.ASR_ARCHIVE_DIR ||
  path.join(HOME_DIR, '.openclaw', 'workspace', 'data', 'voice-archive');

// --- HTTP helpers ---

/** Build multipart form body for OpenAI-style transcription */
function buildMultipart(model, filename, mime, buf) {
  const boundary = '----VoiceTranscriber' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { body, boundary };
}

/**
 * Send an HTTP POST request.
 * @param {object} cfg - Provider config
 * @param {string} url - Full URL
 * @param {string|Buffer} body - Request body
 * @param {string} contentType - Content-Type header value
 * @param {Function} [lookupFn] - Optional custom DNS lookup (for DNS rebinding prevention)
 * @returns {Promise<string>} Response text
 */
function httpRequest(cfg, url, body, contentType, lookupFn) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const bodyBuf = typeof body === 'string' ? Buffer.from(body) : body;
    const opts = {
      hostname: parsed.hostname, path: parsed.pathname + (parsed.search || ''), method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': contentType,
        'User-Agent': USER_AGENT,
        'Content-Length': bodyBuf.length
      },
      timeout: REQUEST_TIMEOUT_MS
    };
    if (lookupFn) opts.lookup = lookupFn;
    const req = transport.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${json.error?.message || data.slice(0, 200)}`));
          } else {
            resolve(json.choices?.[0]?.message?.content || json.text || '');
          }
        } catch {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(); reject(new Error('Request timeout')); });
    req.write(bodyBuf);
    req.end();
  });
}

// --- Transcription functions ---

/**
 * Transcribe audio from file or URL.
 * @param {string} audioSource - Local file path or HTTP(S) URL
 * @param {object} cfg - Provider config
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(audioSource, cfg) {
  const isUrl = audioSource.startsWith('http://') || audioSource.startsWith('https://');
  let lookupFn;
  if (isUrl) {
    const result = await validateUrl(audioSource);
    lookupFn = result.lookupFn;
  }
  if (cfg.style === 'qwen') return transcribeQwen(audioSource, isUrl, cfg, lookupFn);
  return transcribeOpenAI(audioSource, isUrl, cfg, lookupFn);
}

/** Transcribe using Qwen-style API (chat/completions + input_audio) */
function transcribeQwen(audioSource, isUrl, cfg, lookupFn) {
  let inputAudio;
  if (isUrl) {
    inputAudio = { data: audioSource };
  } else {
    const { resolved, ext } = validateLocalFile(audioSource);
    const buf = fs.readFileSync(resolved);
    const mime = safeMimeType(AUDIO_MIME_MAP[ext]);
    inputAudio = { data: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const payload = JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: inputAudio }] }],
    stream: false
  });
  return httpRequest(cfg, `${cfg.baseUrl}/chat/completions`, payload, 'application/json', null, lookupFn);
}

/** Transcribe using OpenAI-style API (/audio/transcriptions + multipart) */
function transcribeOpenAI(audioSource, isUrl, cfg, lookupFn) {
  if (isUrl) return downloadThenTranscribe(audioSource, cfg, MAX_REDIRECTS, new Set(), lookupFn);
  const { resolved, ext } = validateLocalFile(audioSource);
  const buf = fs.readFileSync(resolved);
  const safeName = sanitizeFilename(path.basename(resolved));
  const mime = safeMimeType(AUDIO_MIME_MAP[ext]);
  const { body, boundary } = buildMultipart(cfg.model, safeName, mime, buf);
  return httpRequest(cfg, `${cfg.baseUrl}/audio/transcriptions`, body, `multipart/form-data; boundary=${boundary}`, null, lookupFn);
}

/** Download audio from URL with redirect/size limits, then transcribe via OpenAI-style API */
async function downloadThenTranscribe(url, cfg, redirectsLeft, visited, lookupFn) {
  if (redirectsLeft <= 0) throw new Error('Too many redirects');
  // Detect redirect cycles
  const urlKey = url.split('#')[0]; // ignore fragment
  if (visited.has(urlKey)) throw new Error('Redirect cycle detected');
  visited.add(urlKey);
  await validateUrl(url);

  const proto = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const getOpts = { timeout: REQUEST_TIMEOUT_MS };
    if (lookupFn) getOpts.lookup = lookupFn;
    proto.get(url, getOpts, (res) => {
      // Handle redirects — resolve relative URLs and re-validate
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let nextUrl = res.headers.location;
        try {
          nextUrl = new URL(nextUrl, url).href;
        } catch (parseErr) {
          reject(new Error(`Invalid redirect URL: ${nextUrl}`));
          return;
        }
        if (!nextUrl.startsWith('http://') && !nextUrl.startsWith('https://')) {
          reject(new Error(`Redirect to non-HTTP protocol blocked: ${nextUrl}`));
          return;
        }
        return downloadThenTranscribe(nextUrl, cfg, redirectsLeft - 1, visited, lookupFn).then(resolve, reject);
      }
      // Check status
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      // Pre-check Content-Length to reject oversized files early
      const contentLength = parseInt(res.headers['content-length'], 10);
      if (!isNaN(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        res.resume();
        reject(new Error(`Download too large: ${(contentLength / 1024 / 1024).toFixed(1)}MB (max ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB)`));
        return;
      }
      // Download with size limit
      let bytesReceived = 0;
      const chunks = [];
      res.on('data', (c) => {
        bytesReceived += c.length;
        if (bytesReceived > MAX_DOWNLOAD_BYTES) {
          res.destroy();
          reject(new Error(`Download too large: >${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB`));
        } else {
          chunks.push(c);
        }
      });
      res.on('end', () => {
        if (bytesReceived === 0) {
          reject(new Error('Downloaded file is empty'));
          return;
        }
        const buf = Buffer.concat(chunks);
        // Detect MIME from response Content-Type, fallback to audio/wav
        const ctHeader = res.headers['content-type'] || '';
        const detectedMime = safeMimeType(
          ctHeader.includes('ogg') ? 'audio/ogg'
          : ctHeader.includes('mpeg') || ctHeader.includes('mp3') ? 'audio/mpeg'
          : ctHeader.includes('mp4') || ctHeader.includes('m4a') ? 'audio/mp4'
          : ctHeader.includes('webm') ? 'audio/webm'
          : ctHeader.includes('opus') ? 'audio/opus'
          : ctHeader.includes('flac') ? 'audio/flac'
          : 'audio/wav'
        );
        const { body, boundary } = buildMultipart(cfg.model, 'audio', detectedMime, buf);
        httpRequest(cfg, `${cfg.baseUrl}/audio/transcriptions`, body, `multipart/form-data; boundary=${boundary}`, null, lookupFn).then(resolve, reject);
      });
      res.on('error', reject);
    }).on('timeout', function () { this.destroy(); reject(new Error('Download timeout')); })
      .on('error', reject);
  });
}

// --- CLI ---
const args = process.argv.slice(2);
const audioInput = args.find(a => !a.startsWith('--'));
const doArchive = args.includes('--archive');

if (!audioInput) {
  process.stderr.write('Usage: node claw-voice-transcriber.js <audio_file_path_or_url> [--archive]\n');
  process.exit(1);
}

(async () => {
  try {
    // Archive local files before transcription
    if (doArchive && !audioInput.startsWith('http')) {
      const { resolved, ext } = validateLocalFile(audioInput);
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const ms = String(Date.now() % 1000).padStart(3, '0');
      const rand = crypto.randomBytes(2).toString('hex');
      const dest = path.join(ARCHIVE_DIR, `${date}_${ms}_${rand}.${ext}`);
      fs.copyFileSync(resolved, dest);
      process.stderr.write(`Archived: ${path.basename(dest)}\n`);
    }

    // Try primary provider, fallback on failure
    let text;
    try {
      text = await transcribe(audioInput, config);
    } catch (e) {
      if (config.fallback) {
        process.stderr.write(`Primary provider failed (${e.message}), trying fallback...\n`);
        text = await transcribe(audioInput, config.fallback);
      } else {
        throw e;
      }
    }
    process.stdout.write(text);
  } catch (err) {
    // Sanitize error: redact absolute paths and API keys
    const homeRe = new RegExp(HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '/home/[^/]+', 'g');
    const safeMsg = err.message
      .replace(homeRe, '~')
      .replace(/sk-[a-f0-9]{8,}/gi, 'sk-***')
      .replace(/[a-f0-9]{32,}/gi, '[REDACTED-KEY]')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]');
    process.stderr.write(JSON.stringify({ error: safeMsg }) + '\n');
    process.exit(1);
  }
})();
