#!/usr/bin/env node
/**
 * Voice Transcriber: Audio file → text via OpenAI-compatible ASR API
 *
 * Config priority (highest → lowest):
 *   1. <agentDir>/claw-voice-transcriber.json  (per-agent override)
 *   2. <workspace>/config/claw-voice-transcriber.json  (workspace override)
 *   3. Environment variables (ASR_API_KEY, ASR_BASE_URL, ASR_MODEL)
 *   4. openclaw.json skills.entries.claw-voice-transcriber.env (global default)
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
 *   node asr.js <audio_file_path_or_url> [--archive]
 *
 * Output: recognized text to stdout (JSON on error)
 * Requirements: node >= 18, no external dependencies
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;

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
const DEFAULTS = {
  alibabaQwen: {
    apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash', style: 'qwen'
  }
};

// --- Utility functions ---

/** Resolve ${ENV_VAR} references recursively in strings and objects */
function resolveEnvRefs(obj) {
  if (typeof obj === 'string') return obj.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] || '');
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
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    const safeName = path.basename(filePath).replace(process.env.HOME || '', '~');
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
  // bidirectional overrides, zero-width chars, and other unicode control chars
  return base
    .replace(/[\r\n\x00-\x1f\x7f\u0080-\u009f\u2028\u2029\u202A-\u202E\u200B-\u200D\uFEFF]/g, '')
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
 * Uses statSync directly to avoid TOCTOU race between existsSync and statSync.
 * @param {string} filePath - File path to validate
 * @returns {{ resolved: string, ext: string, size: number }}
 */
function validateLocalFile(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).slice(1).toLowerCase();

  // Single statSync call to check existence, size, and file type atomically
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`File not found: ${path.basename(resolved)}`);
    throw new Error(`Cannot access file: ${path.basename(resolved)}`);
  }

  // Reject symlinks
  if (stat.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed: ${path.basename(resolved)}`);
  }

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
  if (/^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/.test(hostname)) {
    return true;
  }

  // Check for hex/octal/decimal IP formats by attempting DNS resolution (with timeout)
  try {
    const addresses = await Promise.race([
      dns.resolve4(hostname),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000))
    ]);
    for (const addr of addresses) {
      if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(addr)) {
        return true;
      }
    }
  } catch {
    // DNS resolution failed - if it looks like a raw IP (numeric), try to parse it
    if (/^\d+$/.test(hostname)) {
      const num = parseInt(hostname, 10);
      if (!isNaN(num)) {
        const a = (num >>> 24) & 0xff, b = (num >>> 16) & 0xff, c = (num >>> 8) & 0xff, d = num & 0xff;
        if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
          return true;
        }
      }
    }
    // Hex IP: 0x7f000001
    if (/^0x[0-9a-f]+$/i.test(hostname)) {
      const num = parseInt(hostname, 16);
      if (!isNaN(num)) {
        const a = (num >>> 24) & 0xff, b = (num >>> 16) & 0xff;
        if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
          return true;
        }
      }
    }
    // Octal IP: 0177.0.0.1
    if (/^0[0-7]+/.test(hostname)) {
      try {
        const parts = hostname.split('.');
        if (parts.length === 4 && parts.every(p => /^0?[0-7]+$/.test(p))) {
          const octets = parts.map(p => parseInt(p, 8));
          const [a, b] = octets;
          if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
            return true;
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return false;
}

/**
 * Validate a URL for safe HTTP(S) access.
 * Blocks private IPs (including hex/octal/decimal formats) and non-HTTP protocols.
 * @param {string} url - URL to validate
 * @returns {Promise<URL>} Parsed URL object
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
  return parsed;
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
  if (!['qwen', 'openai'].includes(cfg.style)) {
    throw new Error(`Invalid style: "${cfg.style}". Must be "qwen" or "openai".`);
  }
  if (cfg.fallback) validateConfig(cfg.fallback);
}

// --- Config resolution ---

/**
 * Resolve ASR configuration from multiple sources.
 * Priority: agent config > workspace config > env vars > defaults
 * @returns {object} Resolved config with apiKey, baseUrl, model, style, fallback
 */
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
        process.env.HOME, '.openclaw', 'agents', agentId, 'agent', 'claw-voice-transcriber.json'
      ));
    }
  }

  // Use highest-priority config (resolve ${ENV_VAR} refs)
  const cfg = resolveEnvRefs(agentCfg || wsCfg || null);

  if (cfg && cfg.providers) {
    const primary = cfg.primaryProvider || Object.keys(cfg.providers)[0] || 'alibaba-qwen';
    const fallback = cfg.fallbackProvider || null;
    const provider = cfg.providers[primary] || DEFAULTS.alibabaQwen;
    const fallbackProvider = fallback ? (cfg.providers[fallback] || null) : null;
    return {
      apiKey: provider.apiKey || envKey,
      baseUrl: (provider.baseUrl || envUrl).replace(/\/+$/, ''),
      model: provider.model || envModel || DEFAULTS.alibabaQwen.model,
      style: provider.style || envStyle || 'qwen',
      fallback: fallbackProvider ? {
        apiKey: fallbackProvider.apiKey || envKey,
        baseUrl: (fallbackProvider.baseUrl || envUrl).replace(/\/+$/, ''),
        model: fallbackProvider.model || envModel || 'whisper-1',
        style: fallbackProvider.style || envStyle || 'openai',
      } : null
    };
  }

  // Flat config (legacy or simple)
  const flat = cfg || {};
  return {
    apiKey: flat.apiKey || envKey,
    baseUrl: (flat.baseUrl || envUrl || DEFAULTS.alibabaQwen.baseUrl).replace(/\/+$/, ''),
    model: flat.model || envModel || DEFAULTS.alibabaQwen.model,
    style: flat.style || envStyle || (flat.baseUrl || envUrl || DEFAULTS.alibabaQwen.baseUrl).includes('dashscope') ? 'qwen' : 'openai',
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
  path.join(process.env.HOME, '.openclaw', 'workspace', 'data', 'voice-archive');

// --- HTTP helpers ---

/**
 * Send an HTTP POST request with string body.
 * @param {object} cfg - Provider config
 * @param {string} url - Full URL
 * @param {string} payload - Request body
 * @param {string} contentType - Content-Type header value
 * @returns {Promise<string>} Response text
 */
function httpRequest(cfg, url, payload, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': contentType,
        'User-Agent': USER_AGENT,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${json.error?.message || body.slice(0, 200)}`));
          } else {
            resolve(json.choices?.[0]?.message?.content || json.text || '');
          }
        } catch (e) {
          reject(new Error(`Parse error: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Send an HTTP POST request with raw Buffer body (multipart).
 * @param {object} cfg - Provider config
 * @param {string} url - Full URL
 * @param {Buffer} bodyBuffer - Raw request body
 * @param {string} boundary - Multipart boundary string
 * @returns {Promise<string>} Response text
 */
function httpRequestRaw(cfg, url, bodyBuffer, boundary) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'User-Agent': USER_AGENT,
        'Content-Length': bodyBuffer.length
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${json.error?.message || body.slice(0, 200)}`));
          } else {
            resolve(json.text || json.choices?.[0]?.message?.content || '');
          }
        } catch (e) {
          reject(new Error(`Parse error: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(); reject(new Error('Request timeout')); });
    req.write(bodyBuffer);
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
  if (isUrl) await validateUrl(audioSource);
  if (cfg.style === 'qwen') return transcribeQwen(audioSource, isUrl, cfg);
  return transcribeOpenAI(audioSource, isUrl, cfg);
}

/** Transcribe using Qwen-style API (chat/completions + input_audio) */
function transcribeQwen(audioSource, isUrl, cfg) {
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
  return httpRequest(cfg, `${cfg.baseUrl}/chat/completions`, payload, 'application/json');
}

/** Transcribe using OpenAI-style API (/audio/transcriptions + multipart) */
function transcribeOpenAI(audioSource, isUrl, cfg) {
  if (isUrl) return downloadThenTranscribe(audioSource, cfg, MAX_REDIRECTS);
  const { resolved, ext } = validateLocalFile(audioSource);
  const buf = fs.readFileSync(resolved);
  const safeName = sanitizeFilename(path.basename(resolved));
  const mime = safeMimeType(AUDIO_MIME_MAP[ext]);
  const boundary = '----VoiceTranscriber' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${cfg.model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mime}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return httpRequestRaw(cfg, `${cfg.baseUrl}/audio/transcriptions`, body, boundary);
}

/** Download audio from URL with redirect/size limits, then transcribe via OpenAI-style API */
async function downloadThenTranscribe(url, cfg, redirectsLeft) {
  if (redirectsLeft <= 0) throw new Error('Too many redirects');
  await validateUrl(url);

  const proto = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    proto.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadThenTranscribe(res.headers.location, cfg, redirectsLeft - 1).then(resolve, reject);
      }
      // Check status
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
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
        const boundary = '----VoiceTranscriber' + crypto.randomBytes(8).toString('hex');
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${cfg.model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio"\r\nContent-Type: audio/wav\r\n\r\n`),
          buf,
          Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        httpRequestRaw(cfg, `${cfg.baseUrl}/audio/transcriptions`, body, boundary).then(resolve, reject);
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
  process.stderr.write('Usage: node asr.js <audio_file_path_or_url> [--archive]\n');
  process.exit(1);
}

(async () => {
  try {
    // Archive local files before transcription
    if (doArchive && !audioInput.startsWith('http')) {
      const { resolved, ext } = validateLocalFile(audioInput);
      if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
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
    const homeRe = new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '/home/[^/]+', 'g');
    const safeMsg = err.message
      .replace(homeRe, '~')
      .replace(/sk-[a-f0-9]{8,}/gi, 'sk-***')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]');
    process.stderr.write(JSON.stringify({ error: safeMsg }) + '\n');
    process.exit(1);
  }
})();
