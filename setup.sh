#!/usr/bin/env bash
set -euo pipefail

# Usage: ./setup.sh --site SITEID
#
# Registers the Telegram webhook + bot description + command list for
# the given site. A single Cloudflare Worker can serve multiple bots —
# they are distinguished by the webhook path /webhook/SITEID.
#
# Per site you need a JSON file `bot-${SITEID}.json` next to this script.
# See `examples/bot.example.json` for the schema.
#
# Env variables (from a .env next to this script or exported beforehand):
#   WEBHOOK_SECRET                    shared by all bots
#   TELEGRAM_TOKEN_${SITEID_UPPER}    per-bot token from @BotFather

SITE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site)
      SITE="$2"
      shift 2
      ;;
    *)
      echo "Unknown parameter: $1" >&2
      echo "Usage: $0 --site SITEID" >&2
      exit 1
      ;;
  esac
done

if [ -z "$SITE" ]; then
  echo "❌ --site SITEID missing" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

SITE_UPPER=$(echo "$SITE" | tr '[:lower:]-' '[:upper:]_')
TOKEN_VAR="TELEGRAM_TOKEN_${SITE_UPPER}"
TOKEN="${!TOKEN_VAR:-${TELEGRAM_TOKEN:-}}"

if [ -z "$TOKEN" ] || [ -z "${WEBHOOK_SECRET:-}" ]; then
  echo "❌ $TOKEN_VAR (or TELEGRAM_TOKEN) and WEBHOOK_SECRET must be set" >&2
  exit 1
fi

BOT_CONFIG="$SCRIPT_DIR/bot-${SITE}.json"
if [ ! -f "$BOT_CONFIG" ]; then
  echo "❌ Bot config $BOT_CONFIG not found" >&2
  exit 1
fi

API="https://api.telegram.org/bot${TOKEN}"

WEBHOOK_URL=$(jq -r '.webhook_url' "$BOT_CONFIG")
ALLOWED_UPDATES=$(jq -c '.allowed_updates' "$BOT_CONFIG")
DESCRIPTION=$(jq -r '.description' "$BOT_CONFIG")
SHORT_DESCRIPTION=$(jq -r '.short_description' "$BOT_CONFIG")
COMMANDS=$(jq -c '.commands' "$BOT_CONFIG")

echo "=== Setup for ${SITE} (${WEBHOOK_URL}) ==="

echo "=== Setting webhook ==="
curl -s -X POST "$API/setWebhook" \
  -d "url=${WEBHOOK_URL}" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d "allowed_updates=${ALLOWED_UPDATES}" | jq .

echo "=== Setting description ==="
curl -s -X POST "$API/setMyDescription" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg d "$DESCRIPTION" '{description: $d}')" | jq .

echo "=== Setting short description ==="
curl -s -X POST "$API/setMyShortDescription" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg d "$SHORT_DESCRIPTION" '{short_description: $d}')" | jq .

echo "=== Setting commands ==="
curl -s -X POST "$API/setMyCommands" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --argjson c "$COMMANDS" '{commands: $c}')" | jq .

echo "=== Verify ==="
curl -s "$API/getWebhookInfo" | jq .
