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
node {baseDir}/scripts/claw-voice-transcriber.js /path/to/audio.ogg
```

Transcribe and archive for training data:

```bash
node {baseDir}/scripts/claw-voice-transcriber.js /path/to/audio.ogg --archive
```

Transcribe from URL:

```bash
node {baseDir}/scripts/claw-voice-transcriber.js https://example.com/audio.mp3
```

## Configuration

### Step 1: Add ASR models in openclaw.json

Add ASR models to `~/.openclaw/openclaw.json` under `models.providers`. Mark each ASR model with `"type": "asr"`:

```json
{
  "models": {
    "providers": {
      "alibaba": {
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKey": "sk-xxx",
        "api": "openai-completions",
        "models": [
          {
            "id": "qwen3-asr-flash",
            "name": "Qwen3 ASR Flash",
            "type": "asr",
            "input": ["audio"]
          }
        ]
      },
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-xxx",
        "models": [
          {
            "id": "whisper-1",
            "name": "OpenAI Whisper",
            "type": "asr",
            "input": ["audio"]
          }
        ]
      },
      "zhipu": {
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiKey": "xxx",
        "api": "openai-completions",
        "models": [
          {
            "id": "glm-asr-2512",
            "name": "Zhipu GLM-ASR",
            "type": "asr",
            "input": ["audio"]
          }
        ]
      }
    }
  }
}
```

The transcriber automatically discovers models with `"type": "asr"` and uses the first one found.

### Step 2 (optional): Set active provider preference

Create `~/.openclaw/config/claw-voice-transcriber-prefs.json` to pick which provider/model to use:

```json
{
  "activeProvider": "alibaba",
  "activeModel": "qwen3-asr-flash"
}
```

Without this file, the first `type: "asr"` model in `models.providers` is used.

### Step 3: Restart Gateway

```bash
openclaw gateway restart
```

## Config Priority

1. Per-agent: `~/.openclaw/agents/<agentId>/agent/claw-voice-transcriber.json`
2. Workspace: `<workspace>/config/claw-voice-transcriber.json`
3. openclaw.json `models.providers` (type: "asr" models) + prefs file
4. Environment variables: `ASR_API_KEY`, `ASR_BASE_URL`, `ASR_MODEL`

> **Backward compatible:** Per-agent and workspace config files still work as before (highest priority).

## Style Detection

The `style` is auto-detected from the provider configuration:

- `api: "openai-completions"` → style `qwen` (chat/completions + input_audio)
- `asrStyle` field on model or provider level (explicit override)
- Falls back to `openai` style, or `qwen` if baseUrl contains `dashscope`

`style: "qwen"` = chat/completions + input_audio (supports base64 local files)
`style: "openai"` = /audio/transcriptions + multipart upload

## Preconfigured Providers

| Provider | baseUrl | model | style |
|----------|---------|-------|-------|
| Alibaba Qwen3-ASR-Flash | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | `qwen` |
| OpenAI Whisper | `https://api.openai.com/v1` | `whisper-1` | `openai` |
| Zhipu GLM-ASR | `https://open.bigmodel.cn/api/paas/v4` | `glm-asr-2512` | `qwen` |

> Alibaba Cloud: activate `qwen3-asr-flash` at https://bailian.console.aliyun.com

## Output

- stdout: recognized text
- stderr: archive path, fallback messages, errors as JSON

## Cost

Alibaba Qwen3-ASR-Flash: ~¥0.013/min, free tier 10 hours.
