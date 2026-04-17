---
name: claw-voice-transcriber
description: >
  Voice-to-text transcription for Chinese, English, and code-switched (mixed Chinese-English) speech.
  Supports multiple ASR providers (Alibaba Qwen3-ASR-Flash, OpenAI Whisper, Zhipu GLM-ASR, any OpenAI-compatible API)
  with automatic fallback. Accepts local audio files (ogg/wav/mp3/m4a) and remote URLs.
  Optionally archives audio files for digital human training data collection.
  Zero external dependencies, Node.js 18 or later.
  Use when: (1) receiving voice messages from Telegram/Signal/WhatsApp,
  (2) user asks for speech-to-text or audio transcription,
  (3) transcribing audio recordings or voice notes,
  (4) collecting voice training data for digital humans or TTS models.
---

# Voice Transcriber

Transcribe audio to text via multiple ASR providers with automatic fallback.

## Quick Start

```bash
node scripts/asr.js /path/to/audio.ogg
```

Transcribe and archive for training data:

```bash
node scripts/asr.js /path/to/audio.ogg --archive
```

Transcribe from URL:

```bash
node scripts/asr.js https://example.com/audio.mp3
```

## Configuration

### Step 1: Set API Key in openclaw.json

Add to `~/.openclaw/openclaw.json` under top-level:

```json
{
  "skills": {
    "entries": {
      "claw-voice-transcriber": {
        "enabled": true,
        "env": {
          "ASR_ALIBABA_API_KEY": "sk-xxx"
        }
      }
    }
  }
}
```

For multiple providers, add separate env vars (e.g. `ASR_OPENAI_API_KEY`, `ASR_ZHIPU_API_KEY`).

### Step 2: Create provider config

Create `~/.openclaw/config/claw-voice-transcriber.json`:

#### Multi-provider (recommended, with fallback)

```json
{
  "primaryProvider": "alibaba-qwen",
  "fallbackProvider": "openai-whisper",
  "providers": {
    "alibaba-qwen": {
      "apiKey": "${ASR_ALIBABA_API_KEY}",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen3-asr-flash",
      "style": "qwen"
    },
    "openai-whisper": {
      "apiKey": "${ASR_OPENAI_API_KEY}",
      "baseUrl": "https://api.openai.com/v1",
      "model": "whisper-1",
      "style": "openai"
    }
  }
}
```

#### Single provider (simple)

```json
{
  "apiKey": "${ASR_ALIBABA_API_KEY}",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3-asr-flash",
  "style": "qwen"
}
```

### Step 3: Restart Gateway

```bash
openclaw gateway restart
```

## Config Priority

1. Per-agent: `~/.openclaw/agents/<agentId>/agent/claw-voice-transcriber.json`
2. Workspace: `<workspace>/config/claw-voice-transcriber.json`
3. Environment variables: `ASR_API_KEY`, `ASR_BASE_URL`, `ASR_MODEL`
4. Global default from openclaw.json env

## Preconfigured Providers

| Provider | baseUrl | model | style |
|----------|---------|-------|-------|
| Alibaba Qwen3-ASR-Flash | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | `qwen` |
| OpenAI Whisper | `https://api.openai.com/v1` | `whisper-1` | `openai` |
| Zhipu GLM-ASR | `https://open.bigmodel.cn/api/paas/v4` | `glm-asr-2512` | `qwen` |

`style: "qwen"` = chat/completions + input_audio (supports base64 local files)
`style: "openai"` = /audio/transcriptions + multipart upload

> Alibaba Cloud: activate `qwen3-asr-flash` at https://bailian.console.aliyun.com

## Output

- stdout: recognized text
- stderr: archive path, fallback messages, errors as JSON

## Cost

Alibaba Qwen3-ASR-Flash: ~¥0.013/min, free tier 10 hours.
