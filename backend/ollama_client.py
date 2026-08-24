import httpx


class OllamaClient:
    def __init__(self, host: str):
        self.host = host.rstrip("/")

    async def chat(self, model: str, messages: list, temperature: float = 0.7) -> str:
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(
                f"{self.host}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "stream": False,
                    "options": {"temperature": temperature},
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data["message"]["content"]

    async def chat_stream(self, model: str, messages: list, temperature: float = 0.7):
        import json

        async with httpx.AsyncClient(timeout=180) as client:
            async with client.stream(
                "POST",
                f"{self.host}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "stream": True,
                    "options": {"temperature": temperature},
                },
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    piece = chunk.get("message", {}).get("content", "")
                    if piece:
                        yield piece
                    if chunk.get("done"):
                        break

    async def list_models(self) -> list:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{self.host}/api/tags")
            resp.raise_for_status()
            return [
                {"name": m["name"], "size": m.get("size", 0), "modified_at": m.get("modified_at")}
                for m in resp.json().get("models", [])
            ]

    async def delete_model(self, name: str):
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request("DELETE", f"{self.host}/api/delete", json={"name": name})
            resp.raise_for_status()

    async def pull_model(self, name: str):
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{self.host}/api/pull", json={"name": name}) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line:
                        yield line
