#!/usr/bin/env bash
# claw-voice-transcriber: Remote one-click install
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/hy-zhang-io/claw-voice-transcriber/main/scripts/install.sh)

set -euo pipefail

REPO="hy-zhang-io/claw-voice-transcriber"
BRANCH="main"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
TMP_DIR=$(mktemp -d)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; cleanup; exit 1; }

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# --- Download files ---
download() {
  info "Downloading skill files..."
  local base="$RAW_BASE"

  curl -fsSL "${base}/SKILL.md" -o "${TMP_DIR}/SKILL.md" || err "Failed to download SKILL.md"
  curl -fsSL "${base}/scripts/claw-voice-transcriber.js" -o "${TMP_DIR}/claw-voice-transcriber.js" || err "Failed to download script"
  curl -fsSL "${base}/scripts/init.sh" -o "${TMP_DIR}/init.sh" || err "Failed to download init.sh"
  chmod +x "${TMP_DIR}/init.sh"
  ok "Downloaded"
}

# --- Run init ---
main() {
  echo ""
  echo -e "${BLUE}🎙️  claw-voice-transcriber - Remote Install${NC}"
  echo ""

  download
  echo ""
  # Pass --provider if user specified one
  bash "${TMP_DIR}/init.sh" "$@"
}

main "$@"
