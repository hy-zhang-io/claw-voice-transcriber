# 🎙️ claw-voice-transcriber

OpenClaw Skill：语音转文字，自动发现 ASR 模型，所有 Agent 全局生效。

## 参考文档

- [OpenClaw Audio and Voice Notes](https://docs.openclaw.ai/nodes/audio) — `tools.media.audio` 配置格式
- [Agent Skills 规范](https://docs.openclaw.ai) — Skill 目录结构和 `{baseDir}` 模板变量

## 快速开始

```bash
# 一行命令安装（无需 git clone）
bash <(curl -fsSL https://raw.githubusercontent.com/hy-zhang-io/claw-voice-transcriber/main/scripts/install.sh) --provider alibaba --api-key sk-xxx

# 重启 Gateway 生效
openclaw gateway restart
```

也可以 git clone 后安装：

```bash
git clone https://github.com/hy-zhang-io/claw-voice-transcriber.git
cd claw-voice-transcriber
bash scripts/init.sh
```

## 工作原理

1. **init.sh** 将 ASR 模型写入 `openclaw.json` 的 `models.providers`，并注册 `tools.media.audio` CLI hook
2. OpenClaw 收到语音消息时，自动调用 `claw-voice-transcriber.js` 转写
3. 脚本从 `openclaw.json` 读取 ASR 配置（`type: "asr"` 的模型），通过偏好文件选择供应商
4. 所有 Agent 全局生效，无需逐个配置

## 配置

### openclaw.json 中的 ASR 模型

在 `models.providers` 中添加 ASR 模型，标记 `"type": "asr"`：

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
      }
    }
  }
}
```

### tools.media.audio CLI hook（自动注册）

init.sh 会自动写入，格式如下：

```json
{
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": [{
          "type": "cli",
          "command": "node",
          "args": ["~/.openclaw/skills/claw-voice-transcriber/scripts/claw-voice-transcriber.js", "{{MediaPath}}"],
          "timeoutSeconds": 30
        }]
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

### API Key 环境变量引用

```json
{ "apiKey": "${ALIBABA_API_KEY}" }
```

## 预置供应商

| 供应商 | baseUrl | 模型 | asrStyle |
|--------|---------|------|----------|
| 阿里千问 | `dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | `qwen` |
| OpenAI | `api.openai.com/v1` | `whisper-1` | `openai` |
| 智谱 | `open.bigmodel.cn/api/paas/v4` | `glm-asr-2512` | `qwen` |

- `asrStyle: "qwen"` — chat/completions + input_audio
- `asrStyle: "openai"` — /audio/transcriptions + multipart upload
- 不指定时自动检测

## 文件结构

```
claw-voice-transcriber/
├── SKILL.md                              # Skill 描述
├── scripts/
│   ├── claw-voice-transcriber.js         # 核心转写脚本
│   ├── init.sh                           # 一键初始化
│   └── install.sh                        # 远程安装入口
└── README.md
```

## 前置条件

- Node.js >= 18
- OpenClaw >= 0.1.0

## License

MIT
