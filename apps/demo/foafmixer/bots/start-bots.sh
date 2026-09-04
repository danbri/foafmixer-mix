#!/usr/bin/env bash
# Launches the Foafmixer MIX bridge bots into the factoidal channel.
# To disable a bot: comment out its whole block below, then rerun this
# script (it kills any currently-running bots first, so this is also how
# you restart everything after an env/code change).
set -euo pipefail

bot_dir="$HOME/working/sandbox/mix/foafmixer-mix/apps/demo/foafmixer/bots"
source "$HOME/.bashrc" >/dev/null 2>&1

pkill -f talkie_bridge.py 2>/dev/null || true
pkill -f talkie_bridge.mjs 2>/dev/null || true
pkill -f skosbot.mjs 2>/dev/null || true
pkill -f model-manager.mjs 2>/dev/null || true
pkill -f llama-server 2>/dev/null || true
sleep 1

# model-manager.mjs owns starting/stopping the llama-server backends now --
# it starts them on demand and stops them after idle (Qwen; Talkie is left
# running once up, see the manager's own notes on why). The bots below
# call it instead of assuming llama-server is already running.
: > "$bot_dir/model-manager.log"
nohup node "$bot_dir/model-manager.mjs" > "$bot_dir/model-manager.log" 2>&1 &
disown
sleep 2
echo "=== pre-warming both backends ==="
curl -s -X POST http://127.0.0.1:8199/touch/talkie; echo
curl -s -X POST http://127.0.0.1:8199/touch/qwen; echo

# Talkie -- 1930s-vintage novelty persona, backend :8188 via the manager
# (Metal produces NaN output for this model's architecture; see repo notes).
: > "$bot_dir/talkie.log"
nohup node "$bot_dir/talkie_bridge.mjs" > "$bot_dir/talkie.log" 2>&1 &
disown

# foafbot -- Qwen3-4B backend on :8189, FOAF/social-web themed persona.
# Currently disabled per request (2026-09-04): "remove the Qwen foafbot from
# the server for now". Uncomment to bring it back.
# : > "$bot_dir/foafbot.log"
# TALKIE_LLAMA_URL=http://127.0.0.1:8189 \
# FOAFMIXER_PURPLEGUEST_JIDANDPWD="foafbot@foafmixer.test 3b434791ea7c699aae7f7ef8e2c588fa2152" \
# TALKIE_NICK=foafbot \
# TALKIE_SYSTEM_PROMPT="You are foafbot, a friendly chat participant in a live XMPP MIX group chat channel, themed around FOAF and the social web -- curious about who people are, how they know each other, and connecting ideas and people. Be concise and warm. Two or three sentences max. Do not prefix your reply with your own name." \
# nohup node "$bot_dir/talkie_bridge.mjs" > "$bot_dir/foafbot.log" 2>&1 &
# disown

# qwenbot -- Qwen3-4B backend on :8189, plain fast/friendly assistant persona.
: > "$bot_dir/qwenbot.log"
TALKIE_NICK=qwenbot \
TALKIE_LLAMA_URL=http://127.0.0.1:8189 \
FOAFMIXER_PURPLEGUEST_JIDANDPWD="qwenchat@foafmixer.test 7c45140daabb273b598a533686b38ca47664" \
TALKIE_SYSTEM_PROMPT="You are qwenbot, a fast, friendly, helpful chat participant in a live XMPP MIX group chat channel. Be concise, cheerful, and direct -- answer what is actually asked using the conversation so far for context. Two or three sentences max. Do not prefix your reply with your own name." \
nohup node "$bot_dir/talkie_bridge.mjs" > "$bot_dir/qwenbot.log" 2>&1 &
disown

# skosbot -- deterministic SKOS/SPARQL query bot over the factoidal-skosgraphs
# store (no LLM). Lives in its own #skos channel, always-on there.
: > "$bot_dir/skosbot.log"
cd "$bot_dir"
TALKIE_CHANNEL=skos TALKIE_NICK=skosbot \
FOAFMIXER_PURPLEGUEST_JIDANDPWD="skosbot@foafmixer.test d0030308e914f03bba3d86584241cd38d34f" \
nohup node "$bot_dir/skosbot.mjs" > "$bot_dir/skosbot.log" 2>&1 &
disown

sleep 5
for f in talkie foafbot qwenbot skosbot; do
  [ -f "$bot_dir/$f.log" ] && { echo "=== $f ==="; cat "$bot_dir/$f.log"; }
done
