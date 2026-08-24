import re
from backend import db
from backend.ollama_client import OllamaClient
from backend.discord_client import post_message
from backend.ws_manager import manager

THINK_RE = re.compile(r"<think>(.*?)</think>", re.DOTALL | re.IGNORECASE)

running = {}  # conversation_id -> {"stop": bool}


def split_thinking(raw: str):
    match = THINK_RE.search(raw)
    if not match:
        return raw.strip(), None
    thinking = match.group(1).strip()
    content = THINK_RE.sub("", raw).strip()
    return content or raw.strip(), thinking


def build_messages(agent, conversation, history):
    messages = [{"role": "system", "content": agent["persona"]}]
    if not history:
        messages.append({"role": "user", "content": conversation["topic"]})
        return messages

    for msg in history:
        if msg["agent_id"] == agent["id"]:
            role = "assistant"
            text = msg["content"]
        elif msg["role"] == "user":
            role = "user"
            text = f"[You (the operator)]: {msg['content']}"
        else:
            role = "user"
            speaker = msg.get("agent_name", "Someone")
            text = f"[{speaker}]: {msg['content']}"
        messages.append({"role": role, "content": text})
    return messages


async def run_conversation(conversation_id: str):
    running[conversation_id] = {"stop": False}
    conversation = db.get_conversation(conversation_id)
    agent_ids = conversation["agent_ids"]
    agents = [db.get_agent(a) for a in agent_ids]
    agents = [a for a in agents if a]
    if not agents:
        db.set_conversation_status(conversation_id, "stopped")
        return

    settings = db.get_settings()
    client = OllamaClient(settings["ollama_host"])
    mirror_agents = settings.get("discord_mirror_agents") == "1"
    webhook = settings.get("discord_webhook_url", "")

    max_turns = conversation["max_turns"]
    turn = sum(1 for m in db.list_messages(conversation_id) if m["role"] == "agent")
    while max_turns is None or turn < max_turns:
        if running.get(conversation_id, {}).get("stop"):
            break

        agent = agents[turn % len(agents)]
        raw_history = db.list_messages(conversation_id)
        name_by_id = {a["id"]: a["name"] for a in agents}
        history = [
            {**m, "agent_name": name_by_id.get(m["agent_id"], "Someone")} for m in raw_history
        ]
        messages = build_messages(agent, conversation, history)

        await manager.broadcast(conversation_id, {
            "type": "stream_start",
            "agent_id": agent["id"], "agent_name": agent["name"], "agent_color": agent["color"],
        })

        raw = ""
        try:
            async for piece in client.chat_stream(agent["model"], messages, agent["temperature"]):
                raw += piece
                await manager.broadcast(conversation_id, {"type": "delta", "agent_id": agent["id"], "text": piece})
        except Exception as exc:
            db.create_message(conversation_id, agent["id"], "system", f"Error calling model: {exc}", None, turn)
            await manager.broadcast(conversation_id, {"type": "error", "detail": str(exc)})
            break

        content, thinking = split_thinking(raw)
        message = db.create_message(conversation_id, agent["id"], "agent", content, thinking, turn)
        await manager.broadcast(conversation_id, {"type": "message", "message": {**message, "agent_name": agent["name"], "agent_color": agent["color"]}})

        if mirror_agents and webhook:
            await post_message(webhook, agent["name"], content)

        turn += 1

    final_status = "stopped" if running.get(conversation_id, {}).get("stop") else "completed"
    db.set_conversation_status(conversation_id, final_status)
    await manager.broadcast(conversation_id, {"type": "status", "status": final_status})
    running.pop(conversation_id, None)


def stop_conversation(conversation_id: str):
    if conversation_id in running:
        running[conversation_id]["stop"] = True
