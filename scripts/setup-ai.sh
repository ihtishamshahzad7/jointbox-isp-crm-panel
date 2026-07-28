#!/bin/bash
# Set up the Jointbox AI assistant with a fully LOCAL, private, free model.
#   - Installs Ollama (open-source local LLM runtime) if missing
#   - Picks a model that fits this server's RAM
#   - Pulls it and prints the .env lines to add
# No data ever leaves this server; no API keys, no usage limits, free forever.
set -e

echo "🧠 Jointbox AI (local, private) setup"

# 1. Install Ollama if not present
if ! command -v ollama >/dev/null 2>&1; then
  echo "→ Installing Ollama…"
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "✔ Ollama already installed"
fi

# 2. Pick a model by available RAM
RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
if [ "${RAM_GB:-0}" -ge 8 ]; then
  MODEL="llama3.1:8b"
elif [ "${RAM_GB:-0}" -ge 4 ]; then
  MODEL="llama3.2:3b"
else
  MODEL="llama3.2:1b"
fi
echo "→ Detected ${RAM_GB:-?} GB RAM → using model: $MODEL"

# 3. Pull the model (first run downloads a few GB)
echo "→ Pulling $MODEL (one-time download)…"
ollama pull "$MODEL"

# 4. Make sure the Ollama service is running and starts on boot
systemctl enable --now ollama 2>/dev/null || true

echo ""
echo "✅ Done. Add these lines to backend/.env, then restart the backend:"
echo ""
echo "AI_BASE_URL=http://localhost:11434/v1"
echo "AI_API_KEY=ollama"
echo "AI_MODEL=$MODEL"
echo ""
echo "Then: pm2 restart jointbox-backend --update-env"
echo "Test:  curl -s http://localhost:11434/api/tags   (should list $MODEL)"
