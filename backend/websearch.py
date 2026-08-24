import re
import html
from urllib.parse import unquote, parse_qs, urlparse

import httpx

RESULT_RE = re.compile(
    r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?'
    r'class="result__snippet"[^>]*>(.*?)</a>',
    re.DOTALL,
)
TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: str) -> str:
    return html.unescape(TAG_RE.sub("", text)).strip()


def _real_url(ddg_redirect: str) -> str:
    """DuckDuckGo's HTML results wrap links in a /l/?uddg=<encoded> redirect."""
    parsed = parse_qs(urlparse(ddg_redirect).query)
    return unquote(parsed.get("uddg", [ddg_redirect])[0])


async def search(query: str, limit: int = 5) -> list[dict]:
    """Plain-text search results only (title/snippet/url) — never fetches or
    executes anything from a result page, just the results listing itself."""
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "Mozilla/5.0"}) as client:
        resp = await client.post("https://html.duckduckgo.com/html/", data={"q": query})
        resp.raise_for_status()

    results = []
    for href, title, snippet in RESULT_RE.findall(resp.text):
        results.append({"title": _clean(title), "snippet": _clean(snippet), "url": _real_url(href)})
        if len(results) >= limit:
            break
    return results


def format_results(results: list[dict]) -> str:
    if not results:
        return "No results found."
    return "\n\n".join(f"{i+1}. {r['title']}\n{r['snippet']}\n{r['url']}" for i, r in enumerate(results))
