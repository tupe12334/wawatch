#!/usr/bin/env bash
# E2E: a headless Claude Code agent answers one demo chat through wawatch MCP.
# Needs a logged-in `claude` CLI, so it is not run in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-4797}
CHAT=111@s.whatsapp.net
DATA=$(mktemp -d)
MCP="$DATA/mcp.json"
npm run build >/dev/null
node dist/cli.js --demo --port "$PORT" --data "$DATA" >"$DATA/server.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -rf "$DATA"' EXIT
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/api/state" >/dev/null && break; sleep 0.2; done
curl -sf -X PATCH "http://127.0.0.1:$PORT/api/chats/$CHAT" -H 'Content-Type: application/json' -d '{"watched":true,"mayReply":true}' >/dev/null
echo "{\"mcpServers\":{\"wawatch\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:$PORT/mcp\"}}}" >"$MCP"
perl -e 'alarm 300; exec @ARGV' claude -p "Follow the wawatch instructions. Watch chat $CHAT. Call wait_for_message until one message arrives from it. Send one short, on-topic reply to that chat with send_message. Then stop and summarize." \
  --mcp-config "$MCP" --strict-mcp-config --allowedTools "mcp__wawatch__*" --max-turns 15 --model haiku >"$DATA/claude.txt" || true
# Assert from outside: exactly one agent message, in the right chat, with the signature.
curl -sf "http://127.0.0.1:$PORT/api/messages?limit=500" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const agent = JSON.parse(s).messages.filter((m) => m.from === "agent");
  const ok = agent.length === 1 && agent[0].chat_id === process.argv[1] && agent[0].text.startsWith("🤖 ");
  console.log(ok ? "PASS: one signed reply in " + process.argv[1] : "FAIL: agent messages = " + JSON.stringify(agent));
  process.exit(ok ? 0 : 1);
});' "$CHAT"
# A chat without May reply must refuse sends.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/send" -H 'Content-Type: application/json' -d '{"chat_id":"222@s.whatsapp.net","text":"x"}')
[ "$CODE" = 403 ] && echo "PASS: send to chat without May reply refused (403)" || { echo "FAIL: got $CODE"; exit 1; }
