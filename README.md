# 🎙️ claw-voice-transcriber

OpenClaw Skill: 语音转文字，支持多供应商 + 自动容灾。

## 特性

- 🌐 **多供应商支持**：阿里千问 Qwen3-ASR-Flash、OpenAI Whisper、智谱 GLM-ASR、任意 OpenAI 兼容 API
- 🔄 **自动容灾**：主供应商失败自动切换备用
- 🔒 **安全加固**：7 轮 Claude Code 安全审查，通过 SSRF/路径穿越/注入等全部检查
- 📦 **零依赖**：纯 Node.js，无需安装额外包
- 🗃️ **语音归档**：可选归档音频文件，用于数字人训练数据采集
- ⚙️ **灵活配置**：四级配置优先级，支持 per-agent 覆盖

## 安装

### 通过 ClawHub（推荐）

```bash
npx clawhub install claw-voice-transcriber
```

### 手动安装

```bash
git clone https://github.com/hy-zhang-io/claw-voice-transcriber.git
cp -r claw-voice-transcriber ~/.openclaw/skills/
```

## 配置

### Step 1: 设置 API Key

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "skills": {
    "entries": {
      "claw-voice-transcriber": {
        "enabled": true,
        "env": {
          "ASR_ALIBABA_API_KEY": "你的阿里百炼API Key"
        }
      }
    }
  }
}
```

多个供应商时添加多个环境变量：

```json
{
  "ASR_ALIBABA_API_KEY": "sk-xxx",
  "ASR_OPENAI_API_KEY": "sk-xxx",
  "ASR_ZHIPU_API_KEY": "xxx"
}
```

### Step 2: 创建供应商配置

创建 `~/.openclaw/config/claw-voice-transcriber.json`：

#### 多供应商（推荐，支持容灾）

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

#### 单供应商（简单配置）

```json
{
  "apiKey": "${ASR_ALIBABA_API_KEY}",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3-asr-flash",
  "style": "qwen"
}
```

### Step 3: 重启 Gateway

```bash
openclaw gateway restart
```

## 使用

```bash
# 转写音频文件
node scripts/asr.js /path/to/audio.ogg

# 转写并归档
node scripts/asr.js /path/to/audio.ogg --archive

# 转写远程 URL
node scripts/asr.js https://example.com/audio.mp3
```

## 预置供应商

| 供应商 | baseUrl | 模型 | 风格 | 价格 | 免费额度 |
|--------|---------|------|------|------|----------|
| 阿里千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | `qwen` | ~¥0.013/min | 10h |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` | `openai` | $0.006/min | 无 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-asr-2512` | `qwen` | ¥0.012/min | 有 |

- `style: "qwen"` — chat/completions + input_audio（支持 base64 本地文件）
- `style: "openai"` — /audio/transcriptions + multipart upload

## 配置优先级

1. **Agent 级**：`~/.openclaw/agents/<agentId>/agent/claw-voice-transcriber.json`
2. **Workspace 级**：`<workspace>/config/claw-voice-transcriber.json`
3. **环境变量**：`ASR_API_KEY`、`ASR_BASE_URL`、`ASR_MODEL`
4. **全局默认**：`openclaw.json` → `skills.entries.claw-voice-transcriber.env`

## 输出

- **stdout**：识别文本
- **stderr**：归档路径、容灾切换信息、JSON 格式错误信息

## 安全

本项目经过 7 轮 Claude Code 安全审查，已实现：

- SSRF 防护（私有 IP 拦截，支持 hex/octal/decimal/IPv6 格式检测）
- 路径穿越防护
- CRLF/Header 注入防护
- Symlink 拒绝
- 错误信息脱敏（路径/Key/IP 自动替换）
- DNS 超时保护
- 输入校验（扩展名白名单、文件大小限制、空文件检测）
- 下载大小限制 + 重定向次数限制 + 请求超时

## 前置条件

- Node.js >= 18
- OpenClaw >= 0.1.0

## License

MIT
