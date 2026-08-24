import re
from backend import db, websearch, uw_client
from backend.ollama_client import OllamaClient
from backend.discord_client import post_message
from backend.ws_manager import manager

THINK_RE = re.compile(r"<think>(.*?)</think>", re.DOTALL | re.IGNORECASE)
REMEMBER_RE = re.compile(r"\[\[REMEMBER:\s*(.+?)\s*\]\]", re.DOTALL | re.IGNORECASE)
SEARCH_RE = re.compile(r"\[\[SEARCH:\s*(.+?)\s*\]\]", re.DOTALL | re.IGNORECASE)
UW_RE = re.compile(r"\[\[UW:\s*(.+?)\s*\]\]", re.DOTALL | re.IGNORECASE)
CONSENSUS_MARKER = "[[CONSENSUS REACHED]]"

SEARCH_INSTRUCTION = (
    "\n\nYou can only speak from training data and whatever's in this conversation — you have no "
    "live information. If a claim needs checking against something current (a price, a filing, "
    "recent news) you may request one web search by including [[SEARCH: your query]] anywhere in "
    "your reply. You'll get back real search results and one chance to give your actual answer "
    "using them — so only search when it would genuinely change your answer, not for things you "
    "already know."
)

UW_INSTRUCTION = (
    "\n\nYou also have access to live Unusual Whales options-market data. To use it, include "
    "[[UW: TICKER]] anywhere in your reply (a single stock ticker, e.g. [[UW: AAPL]]), or "
    "[[UW: MARKET]] for a broad market overview. You'll get back real options flow, dark pool, "
    "price, and fundamentals data and one chance to give your actual answer using it — only "
    "request this when it would genuinely change your answer."
)

running = {}  # conversation_id -> {"stop": bool}

CHAT_PERSONA = "You are a helpful, concise assistant."

CONSENSUS_INSTRUCTION = (
    "\n\nYou are one of several participants discussing the topic together. Actually engage with "
    "what the others say — agree, disagree, or refine your view based on their points, rather than "
    f"just repeating your own position. If you and the group have genuinely reached agreement, end "
    f"your reply with the exact marker {CONSENSUS_MARKER} on its own line. Only use that marker when "
    "real consensus has been reached, not before."
)

MEMORY_TYPES = ("preference", "fact", "conclusion")

MEMORY_WRITE_INSTRUCTION = (
    "\n\nIf you learn something worth remembering long-term, you may save it in this exact "
    "shape: [[REMEMBER: fact: GWRS: GWRS's balance sheet data is missing, which blocks a full "
    "risk/debt-leverage assessment.]] — three parts separated by colons, then ]].\n"
    "1st part — one of exactly: preference, fact, or conclusion. preference is something about "
    "the user (how they like things done, applies everywhere). fact is a specific durable data "
    "point. conclusion is a takeaway or decision this discussion reached.\n"
    "2nd part — a short, consistent label for the subject, like a ticker (GWRS, NVDA). Reuse "
    "the exact same label every time you save something about the same subject. Only leave this "
    "part empty for a preference or something not tied to one subject.\n"
    "3rd part — ONE plain, self-contained sentence someone could understand cold in a different "
    "conversation, without this discussion for context. Don't write a bare note like 'balance "
    "sheet missing' — spell out what it's about. Never name a specific agent (e.g. 'Nova "
    "flagged...') — the agent roster can change, so state the finding itself, not who said it.\n"
    "It's stored automatically and stripped from what's shown — don't overuse it, and never "
    "save the same fact twice."
)


def split_thinking(raw: str):
    match = THINK_RE.search(raw)
    if not match:
        return raw.strip(), None
    thinking = match.group(1).strip()
    content = THINK_RE.sub("", raw).strip()
    return content or raw.strip(), thinking


def normalize_memory(raw: str):
    """Parse a type: topic: fact marker into (type, topic, fact), tolerating
    a model that drops the topic (old two-part "type: fact" shape) or the
    whole format entirely."""
    parts = raw.split(":", 2)
    if len(parts) == 3 and parts[0].strip().lower() in MEMORY_TYPES:
        return parts[0].strip().lower(), parts[1].strip(), parts[2].strip()
    parts = raw.split(":", 1)
    if len(parts) == 2 and parts[0].strip().lower() in MEMORY_TYPES:
        return parts[0].strip().lower(), "", parts[1].strip()
    return "fact", "", raw.strip()


def extract_memories(content: str, default_topic: str = "") -> str:
    for match in REMEMBER_RE.finditer(content):
        mem_type, topic, fact = normalize_memory(match.group(1))
        # A model that drops the topic still produces a fact/conclusion tied
        # to THIS conversation, not something universal — falling back to ""
        # would make relevant_memories() treat it as always-relevant and leak
        # it into every unrelated conversation. Scope it to this conversation
        # instead, unless it's a genuine preference (those apply everywhere).
        if not topic and mem_type != "preference":
            topic = default_topic
        if fact:
            db.create_memory(f"{mem_type}: {fact}", topic=topic)
    return REMEMBER_RE.sub("", content).strip()


def memory_block(topic_hint=""):
    memories = db.relevant_memories(topic_hint)
    if not memories:
        return ""
    facts = "\n".join(f"- {m['content']}" for m in memories)
    return f"\n\nThings you should remember about the user / prior context:\n{facts}"


def rules_block():
    rules = db.get_rules().strip()
    if not rules:
        return ""
    return f"\n\nRules you must always follow:\n{rules}"


def build_messages(agent, conversation, history):
    system = agent["persona"] + CONSENSUS_INSTRUCTION + rules_block() + MEMORY_WRITE_INSTRUCTION + SEARCH_INSTRUCTION + UW_INSTRUCTION + memory_block(conversation["topic"])
    messages = [{"role": "system", "content": system}]
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

    # A fresh operator message easily gets lost as just one more line in a
    # long debate history — this puts an explicit nudge last in context
    # (highest-attention position) so it can't just be glossed over.
    if history[-1]["role"] == "user":
        messages.append({
            "role": "user",
            "content": (
                "The operator just spoke directly to the group above — address what they said "
                "first, explicitly, before continuing the debate. Don't just resume your prior point."
            ),
        })
    return messages


def build_messages_simple(conversation, history):
    system = CHAT_PERSONA + rules_block() + MEMORY_WRITE_INSTRUCTION + SEARCH_INSTRUCTION + UW_INSTRUCTION + memory_block(conversation["topic"])
    messages = [{"role": "system", "content": system}]
    if not history:
        messages.append({"role": "user", "content": conversation["topic"]})
        return messages
    for msg in history:
        role = "user" if msg["role"] == "user" else "assistant"
        messages.append({"role": role, "content": msg["content"]})
    return messages


async def _generate(client, conversation_id, model, temperature, messages, agent_id):
    raw = ""
    async for piece in client.chat_stream(model, messages, temperature):
        raw += piece
        await manager.broadcast(conversation_id, {"type": "delta", "agent_id": agent_id, "text": piece})
    return raw


async def _stream_reply(client, conversation_id, model, temperature, messages, agent_id, agent_name, agent_color, turn, topic=""):
    await manager.broadcast(conversation_id, {
        "type": "stream_start", "agent_id": agent_id, "agent_name": agent_name,
        "agent_color": agent_color, "agent_model": model,
    })
    try:
        raw = await _generate(client, conversation_id, model, temperature, messages, agent_id)
    except Exception as exc:
        db.create_message(conversation_id, agent_id, "system", f"Error calling model: {exc}", None, turn)
        await manager.broadcast(conversation_id, {"type": "error", "detail": str(exc)})
        return None

    content, thinking = split_thinking(raw)

    # Agents get exactly one search and one UW lookup per turn — the follow-up
    # call below never re-checks for another marker, so this can't recurse or loop.
    search_match = SEARCH_RE.search(content)
    uw_match = UW_RE.search(content)
    search_record = None
    uw_record = None
    if search_match or uw_match:
        followup_parts = []
        if search_match:
            query = search_match.group(1)
            await manager.broadcast(conversation_id, {"type": "searching", "agent_id": agent_id, "query": query})
            try:
                results = await websearch.search(query)
                results_text = websearch.format_results(results)
            except Exception as exc:
                results, results_text = [], f"Search failed: {exc}"
            search_record = {"query": query, "results": results}
            followup_parts.append(f"Search results for \"{query}\":\n\n{results_text}")
        if uw_match:
            uw_query = uw_match.group(1)
            await manager.broadcast(conversation_id, {"type": "uw_querying", "agent_id": agent_id, "query": uw_query})
            try:
                uw_text = await uw_client.handle_query(uw_query)
            except Exception as exc:
                uw_text = f"Unusual Whales lookup failed: {exc}"
            uw_record = {"query": uw_query, "result": uw_text}
            followup_parts.append(f"Unusual Whales data for \"{uw_query}\":\n\n{uw_text}")
        followup = messages + [
            {"role": "assistant", "content": content},
            {"role": "user", "content": (
                "\n\n".join(followup_parts) +
                "\n\nNow give your real answer using this. Don't request another search or UW lookup."
            )},
        ]
        try:
            raw = await _generate(client, conversation_id, model, temperature, followup, agent_id)
        except Exception as exc:
            db.create_message(conversation_id, agent_id, "system", f"Error calling model: {exc}", None, turn)
            await manager.broadcast(conversation_id, {"type": "error", "detail": str(exc)})
            return None
        content, thinking2 = split_thinking(raw)
        thinking = thinking2 or thinking

    reached_consensus = CONSENSUS_MARKER in content
    content = content.replace(CONSENSUS_MARKER, "").strip()
    content = SEARCH_RE.sub("", content).strip()
    content = UW_RE.sub("", content).strip()
    content = extract_memories(content, default_topic=topic)
    if not content:
        content = "Agreed — consensus reached." if reached_consensus else "(no additional comment)"

    message = db.create_message(conversation_id, agent_id, "agent", content, thinking, turn, search=search_record, uw=uw_record)
    await manager.broadcast(conversation_id, {
        "type": "message",
        "message": {**message, "agent_name": agent_name, "agent_color": agent_color, "agent_model": model},
    })
    return content, reached_consensus


async def run_chat_turn(conversation_id: str):
    """Simple 1:1 chat mode — generate exactly one reply from current history, no loop."""
    conversation = db.get_conversation(conversation_id)
    if not conversation or not conversation.get("model"):
        return
    settings = db.get_settings()
    client = OllamaClient(settings["ollama_host"])
    history = db.list_messages(conversation_id)
    messages = build_messages_simple(conversation, history)
    turn = sum(1 for m in history if m["role"] == "agent")
    await _stream_reply(
        client, conversation_id, conversation["model"], 0.7, messages,
        None, conversation["model"], "#888888", turn, topic=conversation["topic"],
    )


async def run_consensus_loop(conversation_id: str):
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
    consensus_streak = 0
    reached_consensus = False
    while max_turns is None or turn < max_turns:
        if running.get(conversation_id, {}).get("stop"):
            break

        agent = agents[turn % len(agents)]
        raw_history = db.list_messages(conversation_id)
        name_by_id = {a["id"]: a["name"] for a in agents}
        history = [{**m, "agent_name": name_by_id.get(m["agent_id"], "Someone")} for m in raw_history]
        messages = build_messages(agent, conversation, history)

        result = await _stream_reply(
            client, conversation_id, agent["model"], agent["temperature"], messages,
            agent["id"], agent["name"], agent["color"], turn, topic=conversation["topic"],
        )
        if result is None:
            break
        content, agent_reached_consensus = result

        if mirror_agents and webhook:
            await post_message(webhook, agent["name"], content)

        turn += 1

        # Only declare consensus once every participant has agreed within the
        # same rotation (a "streak" of agreement across one full round), so
        # one agent agreeing early doesn't end the discussion prematurely.
        consensus_streak = consensus_streak + 1 if agent_reached_consensus else 0
        if consensus_streak >= len(agents):
            reached_consensus = True
            break

    if reached_consensus:
        final_status = "completed"
    elif running.get(conversation_id, {}).get("stop"):
        final_status = "stopped"
    else:
        final_status = "completed"
    db.set_conversation_status(conversation_id, final_status)
    await manager.broadcast(conversation_id, {
        "type": "status", "status": final_status, "consensus": reached_consensus,
    })
    running.pop(conversation_id, None)


async def run_conversation(conversation_id: str):
    conversation = db.get_conversation(conversation_id)
    if conversation and conversation.get("mode") == "chat":
        await run_chat_turn(conversation_id)
        db.set_conversation_status(conversation_id, "completed")
        await manager.broadcast(conversation_id, {"type": "status", "status": "completed"})
    else:
        await run_consensus_loop(conversation_id)


def stop_conversation(conversation_id: str):
    if conversation_id in running:
        running[conversation_id]["stop"] = True
