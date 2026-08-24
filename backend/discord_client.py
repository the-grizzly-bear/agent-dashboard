import httpx

MAX_LEN = 1900


async def post_message(webhook_url: str, author: str, content: str):
    if not webhook_url:
        return
    text = f"**{author}:** {content}"
    if len(text) > MAX_LEN:
        text = text[:MAX_LEN] + "…"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            await client.post(webhook_url, json={"content": text})
    except httpx.HTTPError:
        pass
