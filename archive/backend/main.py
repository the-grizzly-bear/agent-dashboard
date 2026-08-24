import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import db, orchestrator
from backend.discord_client import post_message
from backend.ollama_client import OllamaClient
from backend.ws_manager import manager

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Agent Dashboard")
db.init_db()

_background_tasks: set = set()


def spawn(coro):
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


@app.on_event("startup")
async def resume_running_conversations():
    for conversation in db.list_conversations():
        if conversation["status"] == "running":
            spawn(orchestrator.run_conversation(conversation["id"]))


class AgentIn(BaseModel):
    name: str
    persona: str
    model: str
    temperature: float = 0.7
    color: str = "#5b8def"


class AgentPatch(BaseModel):
    name: str | None = None
    persona: str | None = None
    model: str | None = None
    temperature: float | None = None
    color: str | None = None


class ConversationIn(BaseModel):
    topic: str
    agent_ids: list[str]
    max_turns: int | None = None


class MessageIn(BaseModel):
    content: str


class ConversationRename(BaseModel):
    topic: str


class SettingsIn(BaseModel):
    ollama_host: str | None = None
    discord_webhook_url: str | None = None
    discord_mirror_agents: bool | None = None
    discord_mirror_user: bool | None = None


class PullIn(BaseModel):
    name: str


@app.get("/api/agents")
def api_list_agents():
    return db.list_agents()


@app.post("/api/agents")
def api_create_agent(body: AgentIn):
    return db.create_agent(body.name, body.persona, body.model, body.temperature, body.color)


@app.put("/api/agents/{agent_id}")
def api_update_agent(agent_id: str, body: AgentPatch):
    if not db.get_agent(agent_id):
        raise HTTPException(404, "agent not found")
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    return db.update_agent(agent_id, **fields)


@app.delete("/api/agents/{agent_id}")
def api_delete_agent(agent_id: str):
    db.delete_agent(agent_id)
    return {"ok": True}


@app.get("/api/models")
async def api_list_models():
    settings = db.get_settings()
    client = OllamaClient(settings["ollama_host"])
    try:
        return await client.list_models()
    except Exception as exc:
        raise HTTPException(502, f"could not reach ollama: {exc}")


@app.post("/api/models/pull")
async def api_pull_model(body: PullIn):
    settings = db.get_settings()
    client = OllamaClient(settings["ollama_host"])

    async def run_pull():
        async for _ in client.pull_model(body.name):
            pass

    spawn(run_pull())
    return {"started": True, "name": body.name}


@app.get("/api/conversations")
def api_list_conversations():
    return db.list_conversations()


@app.get("/api/conversations/{conversation_id}")
def api_get_conversation(conversation_id: str):
    conversation = db.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(404, "conversation not found")
    return conversation


@app.get("/api/conversations/{conversation_id}/messages")
def api_list_messages(conversation_id: str):
    agents = {a["id"]: a for a in db.list_agents()}
    messages = db.list_messages(conversation_id)
    for m in messages:
        agent = agents.get(m["agent_id"])
        m["agent_name"] = agent["name"] if agent else ("You" if m["role"] == "user" else "System")
        m["agent_color"] = agent["color"] if agent else "#888888"
    return messages


@app.post("/api/conversations")
async def api_create_conversation(body: ConversationIn):
    if not body.agent_ids:
        raise HTTPException(400, "at least one agent is required")
    conversation = db.create_conversation(body.topic, body.agent_ids, body.max_turns)
    spawn(orchestrator.run_conversation(conversation["id"]))
    return conversation


@app.post("/api/conversations/{conversation_id}/messages")
async def api_add_message(conversation_id: str, body: MessageIn):
    conversation = db.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(404, "conversation not found")
    message = db.create_message(conversation_id, None, "user", body.content, None, -1)
    await manager.broadcast(conversation_id, {"type": "message", "message": {**message, "agent_name": "You", "agent_color": "#888888"}})

    settings = db.get_settings()
    if settings.get("discord_mirror_user") == "1" and settings.get("discord_webhook_url"):
        await post_message(settings["discord_webhook_url"], "You", body.content)

    return message


@app.post("/api/conversations/{conversation_id}/stop")
def api_stop_conversation(conversation_id: str):
    orchestrator.stop_conversation(conversation_id)
    return {"ok": True}


@app.delete("/api/conversations/{conversation_id}")
def api_delete_conversation(conversation_id: str):
    orchestrator.stop_conversation(conversation_id)
    db.delete_conversation(conversation_id)
    return {"ok": True}


@app.patch("/api/conversations/{conversation_id}")
def api_rename_conversation(conversation_id: str, body: ConversationRename):
    if not db.get_conversation(conversation_id):
        raise HTTPException(404, "conversation not found")
    return db.rename_conversation(conversation_id, body.topic)


@app.get("/api/settings")
def api_get_settings():
    return db.get_settings()


@app.put("/api/settings")
def api_update_settings(body: SettingsIn):
    values = {}
    for key, value in body.model_dump().items():
        if value is None:
            continue
        values[key] = "1" if value is True else ("0" if value is False else value)
    return db.update_settings(values)


@app.websocket("/ws/conversations/{conversation_id}")
async def ws_conversation(websocket: WebSocket, conversation_id: str):
    await manager.connect(conversation_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(conversation_id, websocket)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
