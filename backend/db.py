import sqlite3
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "dashboard.db"
RULES_PATH = Path(__file__).resolve().parent.parent / "data" / "rules.md"

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    persona TEXT NOT NULL,
    model TEXT NOT NULL,
    temperature REAL DEFAULT 0.7,
    color TEXT DEFAULT '#5b8def',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    agent_ids TEXT NOT NULL,
    max_turns INTEGER,
    status TEXT DEFAULT 'running',
    mode TEXT DEFAULT 'consensus',
    model TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    topic TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    agent_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    thinking TEXT,
    search TEXT,
    uw TEXT,
    turn_index INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def get_conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript(SCHEMA)
    existing_cols = {r["name"] for r in conn.execute("PRAGMA table_info(conversations)")}
    if "mode" not in existing_cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN mode TEXT DEFAULT 'consensus'")
    if "model" not in existing_cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN model TEXT")
    memory_cols = {r["name"] for r in conn.execute("PRAGMA table_info(memories)")}
    if "topic" not in memory_cols:
        conn.execute("ALTER TABLE memories ADD COLUMN topic TEXT DEFAULT ''")
    message_cols = {r["name"] for r in conn.execute("PRAGMA table_info(messages)")}
    if "search" not in message_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN search TEXT")
    if "uw" not in message_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN uw TEXT")
    conn.commit()
    conn.close()


def row_to_agent(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "persona": row["persona"],
        "model": row["model"],
        "temperature": row["temperature"],
        "color": row["color"],
        "created_at": row["created_at"],
    }


def row_to_conversation(row):
    return {
        "id": row["id"],
        "topic": row["topic"],
        "agent_ids": json.loads(row["agent_ids"]),
        "max_turns": row["max_turns"],
        "status": row["status"],
        "mode": row["mode"] or "consensus",
        "model": row["model"],
        "created_at": row["created_at"],
    }


def row_to_message(row):
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "agent_id": row["agent_id"],
        "role": row["role"],
        "content": row["content"],
        "thinking": row["thinking"],
        "search": json.loads(row["search"]) if row["search"] else None,
        "uw": json.loads(row["uw"]) if row["uw"] else None,
        "turn_index": row["turn_index"],
        "created_at": row["created_at"],
    }


def list_agents():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM agents ORDER BY created_at").fetchall()
    conn.close()
    return [row_to_agent(r) for r in rows]


def get_agent(agent_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    conn.close()
    return row_to_agent(row) if row else None


def create_agent(name, persona, model, temperature, color):
    conn = get_conn()
    agent_id = new_id()
    conn.execute(
        "INSERT INTO agents (id, name, persona, model, temperature, color, created_at) VALUES (?,?,?,?,?,?,?)",
        (agent_id, name, persona, model, temperature, color, now()),
    )
    conn.commit()
    conn.close()
    return get_agent(agent_id)


def update_agent(agent_id, **fields):
    if not fields:
        return get_agent(agent_id)
    conn = get_conn()
    cols = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE agents SET {cols} WHERE id = ?", (*fields.values(), agent_id))
    conn.commit()
    conn.close()
    return get_agent(agent_id)


def delete_agent(agent_id):
    conn = get_conn()
    conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    conn.commit()
    conn.close()


def list_conversations():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM conversations ORDER BY created_at DESC").fetchall()
    conn.close()
    return [row_to_conversation(r) for r in rows]


def get_conversation(conversation_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    conn.close()
    return row_to_conversation(row) if row else None


def create_conversation(topic, agent_ids, max_turns, mode="consensus", model=None):
    conn = get_conn()
    conversation_id = new_id()
    conn.execute(
        "INSERT INTO conversations (id, topic, agent_ids, max_turns, status, mode, model, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (conversation_id, topic, json.dumps(agent_ids), max_turns, "running", mode, model, now()),
    )
    conn.commit()
    conn.close()
    return get_conversation(conversation_id)


def rename_conversation(conversation_id, topic):
    conn = get_conn()
    conn.execute("UPDATE conversations SET topic = ? WHERE id = ?", (topic, conversation_id))
    conn.commit()
    conn.close()
    return get_conversation(conversation_id)


def set_conversation_status(conversation_id, status):
    conn = get_conn()
    conn.execute("UPDATE conversations SET status = ? WHERE id = ?", (status, conversation_id))
    conn.commit()
    conn.close()


def delete_conversation(conversation_id):
    conn = get_conn()
    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
    conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    conn.commit()
    conn.close()


def list_messages(conversation_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at", (conversation_id,)
    ).fetchall()
    conn.close()
    return [row_to_message(r) for r in rows]


def create_message(conversation_id, agent_id, role, content, thinking, turn_index, search=None, uw=None):
    conn = get_conn()
    message_id = new_id()
    conn.execute(
        "INSERT INTO messages (id, conversation_id, agent_id, role, content, thinking, search, uw, turn_index, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (message_id, conversation_id, agent_id, role, content, thinking, json.dumps(search) if search else None,
         json.dumps(uw) if uw else None, turn_index, now()),
    )
    conn.commit()
    conn.close()
    return get_message(message_id)


def get_message(message_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    conn.close()
    return row_to_message(row) if row else None


def delete_message(message_id):
    conn = get_conn()
    conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    conn.commit()
    conn.close()


DEFAULT_SETTINGS = {
    "ollama_host": "http://localhost:11434",
    "discord_webhook_url": "",
    "discord_mirror_agents": "0",
    "discord_mirror_user": "0",
    "uw_bearer_token": "",
    "uw_sh": "",
}


def get_rules():
    return RULES_PATH.read_text() if RULES_PATH.exists() else ""


def set_rules(text):
    RULES_PATH.parent.mkdir(parents=True, exist_ok=True)
    RULES_PATH.write_text(text)
    return text


def get_settings():
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    values = dict(DEFAULT_SETTINGS)
    values.update({r["key"]: r["value"] for r in rows})
    values["global_rules"] = get_rules()
    return values


def update_settings(values):
    values = dict(values)
    if "global_rules" in values:
        set_rules(values.pop("global_rules"))
    conn = get_conn()
    for key, value in values.items():
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
    conn.commit()
    conn.close()
    return get_settings()


def row_to_memory(row):
    return {"id": row["id"], "content": row["content"], "topic": row["topic"] or "", "created_at": row["created_at"]}


def list_memories():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM memories ORDER BY topic, created_at").fetchall()
    conn.close()
    return [row_to_memory(r) for r in rows]


def relevant_memories(topic_hint=""):
    """Memories scoped to what's actually relevant to topic_hint (usually the
    conversation topic), instead of dumping every memory into every prompt.
    Untagged memories and preferences (about the user, not one topic) always
    apply; everything else only applies if its topic is mentioned in the hint."""
    hint = (topic_hint or "").lower()
    result = []
    for m in list_memories():
        if not m["topic"] or m["content"].lower().startswith("preference:"):
            result.append(m)
        elif m["topic"].lower() in hint:
            result.append(m)
    return result


def create_memory(content, topic=""):
    conn = get_conn()
    existing = conn.execute(
        "SELECT id FROM memories WHERE lower(trim(content)) = lower(trim(?))", (content,)
    ).fetchone()
    if existing:
        conn.close()
        return get_memory(existing["id"])
    memory_id = new_id()
    conn.execute(
        "INSERT INTO memories (id, content, topic, created_at) VALUES (?,?,?,?)",
        (memory_id, content, topic.strip(), now()),
    )
    conn.commit()
    conn.close()
    return get_memory(memory_id)


def get_memory(memory_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
    conn.close()
    return row_to_memory(row) if row else None


def delete_memory(memory_id):
    conn = get_conn()
    conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    conn.commit()
    conn.close()
