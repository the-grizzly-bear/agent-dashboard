# Agent Dashboard

Minimal dashboard for a custom multi-agent orchestrator running on local Ollama models.
FastAPI backend, SQLite storage, plain HTML/JS frontend (no build step). Optional Discord
webhook mirror for agent conversations and your own injected prompts.

## Setup

```bash
cd ~/projects/agent-dashboard
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Make sure Ollama is running (`ollama serve`, usually already running as a service) and
you've pulled at least one model (`ollama pull llama3.1`), or pull one from the
Settings tab once the dashboard is up.

## Run

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

Open http://localhost:8000

## Usage

1. **Agents tab** — create agent personas: name, system prompt/persona, Ollama model, temperature.
2. **Sessions tab** — start a new session with a topic and a set of participating agents; they take
   turns responding to each other. If a model emits `<think>...</think>`, that's shown as a
   collapsible "thinking" block. You can inject a message into a live session at any time.
3. **Settings tab** — set the Ollama host (defaults to `http://localhost:11434`), pull models,
   and optionally set a Discord webhook URL to mirror agent messages and/or your own prompts.

## Notes

- Turn-taking is round-robin across the selected agents; each agent sees the full transcript
  with other agents' messages labeled by name.
- A session stops after `max_turns` total turns or when you hit Stop.
- Data lives in `data/dashboard.db` (SQLite).
