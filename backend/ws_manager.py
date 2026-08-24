import json
from collections import defaultdict


class ConnectionManager:
    def __init__(self):
        self.connections = defaultdict(set)

    async def connect(self, conversation_id: str, websocket):
        await websocket.accept()
        self.connections[conversation_id].add(websocket)

    def disconnect(self, conversation_id: str, websocket):
        self.connections[conversation_id].discard(websocket)

    async def broadcast(self, conversation_id: str, payload: dict):
        dead = set()
        for ws in self.connections[conversation_id]:
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.connections[conversation_id].discard(ws)


manager = ConnectionManager()
