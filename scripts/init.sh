#!/usr/bin/env bash
# claw-voice-transcriber: One-click initialization script
# Usage: bash init.sh [--provider alibaba|openai|zhipu]

set -euo pipefail

OPENCLAW_DIR="${HOME}/.openclaw"
OPENCLAW_JSON="${OPENCLAW_DIR}/openclaw.json"
CONFIG_DIR="${OPENCLAW_DIR}/config"
PREFS_FILE="${CONFIG_DIR}/claw-voice-transcriber-prefs.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SOURCE_DIR="${SCRIPT_DIR}/.."
SKILL_TARGET_DIR="${OPENCLAW_DIR}/skills/claw-voice-transcriber"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Step 0: Check prerequisites ---
check_prerequisites() {
  info "Checking prerequisites..."

  command -v node >/dev/null 2>&1 || err "Node.js not found. Install Node.js >= 18 first."
  local node_ver
  node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$node_ver" -lt 18 ]; then
    err "Node.js version must be >= 18 (current: $(node -v))"
  fi
  ok "Node.js $(node -v)"

  if [ ! -f "$OPENCLAW_JSON" ]; then
    err "openclaw.json not found at ${OPENCLAW_JSON}. Is OpenClaw installed?"
  fi
  ok "OpenClaw config found"
}

# --- Step 1: Install skill ---
install_skill() {
  info "Installing skill to ${SKILL_TARGET_DIR}..."

  if [ -d "$SKILL_TARGET_DIR" ]; then
    warn "Skill directory already exists, updating..."
    rm -rf "$SKILL_TARGET_DIR"
  fi

  mkdir -p "$SKILL_TARGET_DIR"
  cp -r "${SKILL_SOURCE_DIR}/SKILL.md" "$SKILL_TARGET_DIR/"
  cp -r "${SKILL_SOURCE_DIR}/scripts" "$SKILL_TARGET_DIR/"

  ok "Skill installed"
}

# --- Step 2: Configure provider ---
configure_provider() {
  local provider="${1:-}"

  if [ -z "$provider" ]; then
    echo ""
    echo -e "${BLUE}Select ASR provider:${NC}"
    echo "  1) Alibaba Qwen3-ASR-Flash (recommended, cheapest, supports Chinese)"
    echo "  2) OpenAI Whisper"
    echo "  3) Zhipu GLM-ASR"
    echo "  4) Skip (configure manually later)"
    echo ""
    read -rp "Choice [1-4]: " choice
    case "$choice" in
      1) provider="alibaba" ;;
      2) provider="openai" ;;
      3) provider="zhipu" ;;
      4) echo ""; info "Skipping provider configuration. Edit ${OPENCLAW_JSON} manually."; return ;;
      *) err "Invalid choice" ;;
    esac
  fi

  info "Configuring provider: ${provider}..."

  case "$provider" in
    alibaba)
      local base_url="https://dashscope.aliyuncs.com/compatible-mode/v1"
      local model="qwen3-asr-flash"
      local api_style="openai-completions"
      read -rp "Enter Alibaba DashScope API Key (sk-xxx): " api_key
      ;;
    openai)
      local base_url="https://api.openai.com/v1"
      local model="whisper-1"
      local api_style=""
      read -rp "Enter OpenAI API Key (sk-xxx): " api_key
      ;;
    zhipu)
      local base_url="https://open.bigmodel.cn/api/paas/v4"
      local model="glm-asr-2512"
      local api_style="openai-completions"
      read -rp "Enter Zhipu API Key: " api_key
      ;;
    *)
      err "Unknown provider: ${provider}"
      ;;
  esac

  if [ -z "$api_key" ]; then
    err "API Key cannot be empty"
  fi

  # Add provider to openclaw.json models.providers using node (no jq dependency)
  local tmp_json
  tmp_json=$(node -e "
    const fs = require('fs');
    const cfgPath = '${OPENCLAW_JSON}';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

    if (!cfg.models) cfg.models = {};
    if (!cfg.models.providers) cfg.models.providers = {};

    const provider = cfg.models.providers['${provider}'];
    if (provider) {
      // Update existing provider
      provider.apiKey = '${api_key}';
      provider.baseUrl = '${base_url}';
      provider.models = provider.models || [];
      // Add ASR model if not exists
      if (!provider.models.some(m => m.id === '${model}' && m.type === 'asr')) {
        provider.models.push({
          id: '${model}',
          name: '${model}',
          type: 'asr',
          input: ['audio']${api_style ? ",
          asrStyle: 'qwen'" : ''}
        });
      }
      if ('${api_style}') provider.api = '${api_style}';
    } else {
      // Create new provider
      cfg.models.providers['${provider}'] = {
        apiKey: '${api_key}',
        baseUrl: '${base_url}',
        models: [{
          id: '${model}',
          name: '${model}',
          type: 'asr',
          input: ['audio']${api_style ? ",
          asrStyle: 'qwen'" : ''}
        }]${api_style ? ",
        api: '${api_style}'" : ""}
      };
    }

    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('Provider configured');
  ")

  if [ "$tmp_json" = "Provider configured" ]; then
    ok "Provider '${provider}' (${model}) added to openclaw.json"
  else
    err "Failed to configure provider"
  fi
}

# --- Step 3: Create prefs ---
create_prefs() {
  info "Creating preference file..."

  mkdir -p "$CONFIG_DIR"

  local provider="${1:-alibaba}"
  local model
  case "$provider" in
    alibaba) model="qwen3-asr-flash" ;;
    openai)  model="whisper-1" ;;
    zhipu)   model="glm-asr-2512" ;;
    *) model="qwen3-asr-flash" ;;
  esac

  cat > "$PREFS_FILE" << EOF
{
  "activeProvider": "${provider}",
  "activeModel": "${model}"
}
EOF

  ok "Preferences saved to ${PREFS_FILE}"
}

# --- Step 4: Verify ---
verify() {
  info "Verifying installation..."

  # Check skill files
  [ -f "${SKILL_TARGET_DIR}/SKILL.md" ] || err "SKILL.md not found"
  [ -f "${SKILL_TARGET_DIR}/scripts/claw-voice-transcriber.js" ] || err "Script not found"
  ok "Skill files present"

  # Check script syntax
  node --check "${SKILL_TARGET_DIR}/scripts/claw-voice-transcriber.js" || err "Script syntax error"
  ok "Script syntax OK"

  # Check config
  local asr_count
  asr_count=$(node -e "
    const cfg = JSON.parse(require('fs').readFileSync('${OPENCLAW_JSON}', 'utf8'));
    let count = 0;
    for (const p of Object.values(cfg.models?.providers || {})) {
      for (const m of (p.models || [])) { if (m.type === 'asr') count++; }
    }
    console.log(count);
  ")
  if [ "$asr_count" -eq 0 ]; then
    warn "No ASR models found in openclaw.json. Transcription may not work."
  else
    ok "${asr_count} ASR model(s) configured"
  fi

  # Check prefs
  if [ -f "$PREFS_FILE" ]; then
    ok "Preference file found"
  fi
}

# --- Step 5: Print summary ---
summary() {
  echo ""
  echo -e "${GREEN}======================================${NC}"
  echo -e "${GREEN}  claw-voice-transcriber initialized!  ${NC}"
  echo -e "${GREEN}======================================${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Restart OpenClaw gateway:"
  echo -e "     ${BLUE}openclaw gateway restart${NC}"
  echo ""
  echo "  2. Send a voice message to test"
  echo ""
  echo "  3. To switch ASR provider, edit:"
  echo -e "     ${BLUE}${PREFS_FILE}${NC}"
  echo ""
  echo "  4. To add more providers, edit:"
  echo -e "     ${BLUE}${OPENCLAW_JSON}${NC}"
  echo -e "     Add models with ${YELLOW}\"type\": \"asr\"${NC} under models.providers"
  echo ""
}

# --- Main ---
main() {
  local provider=""
  if [ "${1:-}" = "--provider" ] && [ -n "${2:-}" ]; then
    provider="$2"
  fi

  echo ""
  echo -e "${BLUE}🎙️  claw-voice-transcriber - Initialization${NC}"
  echo ""

  check_prerequisites
  install_skill
  configure_provider "$provider"
  create_prefs "$provider"
  verify
  summary
}

main "$@"
