# 🎙️ claw-voice-transcriber

OpenClaw Skill：语音转文字，支持多供应商自动发现 + 一键初始化。

## 特性

- 🌐 **多供应商**：阿里千问 Qwen3-ASR-Flash、OpenAI Whisper、智谱 GLM-ASR、任意 OpenAI 兼容 API
- 🔍 **自动发现**：从 `openclaw.json` 的 `models.providers` 中自动识别 `type: "asr"` 模型
- 🔄 **自动容灾**：主供应商失败自动切换备用
- ⚡ **一键初始化**：交互式脚本，30 秒完成安装配置
- 🔒 **安全加固**：多轮 Claude Code 安全审查，SSRF/路径穿越/注入/IPv6 全覆盖
- 📦 **零依赖**：纯 Node.js，无需安装额外包
- 🗃️ **语音归档**：可选归档音频文件，用于数字人训练数据采集
- ⚙️ **灵活配置**：四级配置优先级 + 偏好文件切换供应商

## 快速开始

```bash
# 克隆项目
git clone https://github.com/hy-zhang-io/claw-voice-transcriber.git
cd claw-voice-transcriber

# 一键初始化（交互式引导）
bash scripts/init.sh

# 或指定供应商
bash scripts/init.sh --provider alibaba
bash scripts/init.sh --provider openai
bash scripts/init.sh --provider zhipu

# 重启 Gateway 生效
openclaw gateway restart
```

初始化脚本会自动完成：
1. ✅ 检查 Node.js 和 OpenClaw 环境
2. ✅ 安装 Skill 到 `~/.openclaw/skills/claw-voice-transcriber/`
3. ✅ 引导配置 ASR 供应商 API Key
4. ✅ 写入 `openclaw.json`（自动添加 `type: "asr"` 模型）
5. ✅ 创建偏好文件 `~/.openclaw/config/claw-voice-transcriber-prefs.json`
6. ✅ 验证安装完整性

## 使用

安装完成后，直接在 Telegram/Signal/WhatsApp 发送语音消息，OpenClaw 会自动调用转写。

手动测试：
```bash
node ~/.openclaw/skills/claw-voice-transcriber/scripts/claw-voice-transcriber.js /path/to/audio.ogg
node ~/.openclaw/skills/claw-voice-transcriber/scripts/claw-voice-transcriber.js /path/to/audio.ogg --archive
node ~/.openclaw/skills/claw-voice-transcriber/scripts/claw-voice-transcriber.js https://example.com/audio.mp3
```

## 配置

### 方式一：一键初始化（推荐）

```bash
bash scripts/init.sh
```

### 方式二：手动配置

在 `~/.openclaw/openclaw.json` 的 `models.providers` 中添加 ASR 模型，标记 `"type": "asr"`：

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
            "input": ["audio"],
            "asrStyle": "qwen"
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
            "input": ["audio"],
            "asrStyle": "qwen"
          }
        ]
      }
    }
  }
}
```

### 切换供应商

编辑 `~/.openclaw/config/claw-voice-transcriber-prefs.json`：

```json
{
  "activeProvider": "alibaba",
  "activeModel": "qwen3-asr-flash"
}
```

### 环境变量引用

API Key 也支持环境变量引用（推荐，避免明文写入配置文件）：

```json
{
  "apiKey": "${ALIBABA_API_KEY}"
}
```

## 预置供应商

| 供应商 | baseUrl | 模型 | asrStyle | 价格 | 免费额度 |
|--------|---------|------|----------|------|----------|
| 阿里千问 | `dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | `qwen` | ~¥0.013/min | 10h |
| OpenAI | `api.openai.com/v1` | `whisper-1` | `openai` | $0.006/min | 无 |
| 智谱 | `open.bigmodel.cn/api/paas/v4` | `glm-asr-2512` | `qwen` | ¥0.012/min | 有 |

- `asrStyle: "qwen"` — chat/completions + input_audio（支持 base64 本地文件）
- `asrStyle: "openai"` — /audio/transcriptions + multipart upload
- 不指定 `asrStyle` 时自动检测：`api: "openai-completions"` → qwen，baseUrl 含 `dashscope` → qwen，否则 openai

## 配置优先级

1. **Agent 级**：`~/.openclaw/agents/<agentId>/agent/claw-voice-transcriber.json`（独立配置，最高优先）
2. **Workspace 级**：`<workspace>/config/claw-voice-transcriber.json`
3. **OpenClaw 全局**：`openclaw.json` → `models.providers` 中 `type: "asr"` 的模型 + 偏好文件
4. **环境变量**：`ASR_API_KEY`、`ASR_BASE_URL`、`ASR_MODEL`

> **向后兼容**：方式 1、2 的独立配置文件仍然有效，优先级最高。

## 输出

- **stdout**：识别文本
- **stderr**：归档路径、容灾切换信息、JSON 格式错误信息

## 安全

经过多轮 Claude Code 安全审查（含 max effort），已实现：

- ✅ SSRF 防护（私有 IP 拦截，支持 IPv4/IPv6/hex/octal/decimal 格式）
- ✅ DNS rebinding 缓解（lookup pinning）
- ✅ 路径穿越防护
- ✅ Symlink 拒绝（lstat 检测）
- ✅ CRLF/Header 注入防护
- ✅ 重定向安全（协议校验 + 循环检测 + URL 重新验证）
- ✅ 错误信息脱敏（路径/Key/IP 自动替换）
- ✅ 下载保护（大小限制 + Content-Length 预检 + 超时）
- ✅ 输入校验（扩展名白名单、文件大小限制、空文件检测）

## 前置条件

- Node.js >= 18
- OpenClaw >= 0.1.0

## 文件结构

```
claw-voice-transcriber/
├── SKILL.md                              # Skill 描述文件
├── scripts/
│   ├── claw-voice-transcriber.js         # 核心转写脚本
│   └── init.sh                           # 一键初始化脚本
└── README.md                             # 本文件
```

## License

MIT
