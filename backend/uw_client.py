"""Unusual Whales data access via its internal web-app API (no official public
API available on this account). Auth works by replaying the static
Authorization/uw-sh headers a logged-in browser session uses — verified via
HAR capture that uw-sh stays constant across hundreds of requests and many
pages, i.e. it's a session-scoped value, not a per-request signature.

Credentials live in the settings table (uw_bearer_token / uw_sh), editable
from the dashboard's Settings modal — re-capture them via a fresh HAR export
if they ever stop working (session expiry, logout, etc.)."""

import asyncio

import httpx

from backend import db

BASE_URL = "https://phx.unusualwhales.com/api"


def _headers() -> dict:
    settings = db.get_settings()
    return {
        "authorization": f"Bearer {settings.get('uw_bearer_token', '')}",
        "accept": "application/json",
        "origin": "https://unusualwhales.com",
        "referer": "https://unusualwhales.com/",
        "uw-path": "/live-options-flow",
        "uw-sh": settings.get("uw_sh", ""),
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    }


async def _get(path: str, params: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=15, headers=_headers()) as client:
        resp = await client.get(f"{BASE_URL}{path}", params=params)
        resp.raise_for_status()
        return resp.json()


async def market_overview() -> dict:
    return await _get("/market-overview")


async def option_flow(limit: int = 200) -> list[dict]:
    """Recent option-trade prints, market-wide. Ticker filtering happens
    client-side (in filter_by_ticker) — the API's own ticker query params
    (ticker_symbol/tickers[]/symbol) don't actually filter this endpoint."""
    data = await _get("/option_trades_v2", {"limit": limit, "order": "Time"})
    return data.get("data", [])


def filter_by_ticker(trades: list[dict], ticker: str) -> list[dict]:
    ticker = ticker.upper()
    return [t for t in trades if t.get("underlying_symbol") == ticker]


async def dark_pool(ticker: str, limit: int = 20) -> list[dict]:
    data = await _get("/flow/dark-pool", {"ticker_symbol": ticker.upper(), "limit": limit})
    return data.get("trades", [])


async def company_info(ticker: str) -> dict:
    data = await _get(f"/companies/{ticker.upper()}", {"thin": "true"})
    return data.get("company", {})


async def price(ticker: str) -> dict:
    return await _get(f"/ticker/{ticker.upper()}/price")


async def max_pain(ticker: str) -> dict:
    return await _get(f"/max-pain/{ticker.upper()}")


async def gex(ticker: str) -> dict:
    return await _get(f"/gex/{ticker.upper()}")


async def news(ticker: str, limit: int = 5) -> list[dict]:
    data = await _get("/news/headlines-feed/ticker-search", {"ticker": ticker.upper()})
    items = data if isinstance(data, list) else data.get("data", [])
    return items[:limit]


async def ticker_snapshot(ticker: str) -> str:
    """Everything an agent would want about one ticker, condensed to text."""
    ticker = ticker.upper()
    results = await asyncio.gather(
        company_info(ticker), price(ticker), max_pain(ticker), gex(ticker),
        dark_pool(ticker, limit=10), option_flow(limit=300),
        return_exceptions=True,
    )
    info, px, mp, gx, dp, flow = [r if not isinstance(r, BaseException) else None for r in results]
    return format_snapshot(ticker, info, px, mp, gx, dp, flow)


def format_snapshot(ticker, info, px, mp, gx, dp, flow) -> str:
    lines = [f"Unusual Whales snapshot for {ticker}:"]

    if isinstance(info, dict) and info:
        lines.append(
            f"- {info.get('full_name', ticker)} | marketcap ${info.get('marketcap', '?')} | "
            f"P/E {info.get('pe_ratio', '?')} | next earnings {info.get('next_earnings_date', '?')}"
        )
    if isinstance(px, dict) and px:
        lines.append(f"- Price data: {px}")
    if isinstance(mp, dict) and mp.get("date"):
        lines.append(f"- Max pain date {mp.get('date')}")
    if isinstance(gx, dict) and gx:
        lines.append(f"- GEX data available (raw): {str(gx)[:300]}")
    if isinstance(dp, list) and dp:
        total_prem = sum(float(t.get("premium", 0)) for t in dp)
        lines.append(f"- Dark pool: {len(dp)} recent prints, ${total_prem:,.0f} total premium")
    if isinstance(flow, list):
        matches = filter_by_ticker(flow, ticker)
        if matches:
            calls = sum(1 for t in matches if t.get("option_type") == "call")
            puts = len(matches) - calls
            total_prem = sum(float(t.get("premium", 0)) for t in matches)
            lines.append(
                f"- Options flow (last {len(flow)} market-wide prints): {len(matches)} for {ticker} "
                f"({calls} calls / {puts} puts), ${total_prem:,.0f} total premium"
            )
        else:
            lines.append(f"- Options flow: no {ticker} prints in the last {len(flow)} market-wide trades")

    if len(lines) == 1:
        return f"No Unusual Whales data could be retrieved for {ticker}."
    return "\n".join(lines)


async def market_summary() -> str:
    results = await asyncio.gather(
        market_overview(), option_flow(limit=200), return_exceptions=True
    )
    overview, flow = [r if not isinstance(r, BaseException) else None for r in results]
    lines = ["Unusual Whales market overview:"]
    if isinstance(overview, dict) and overview:
        lines.append(f"- {overview}")
    if isinstance(flow, list) and flow:
        by_symbol: dict[str, float] = {}
        for t in flow:
            sym = t.get("underlying_symbol")
            if sym:
                by_symbol[sym] = by_symbol.get(sym, 0) + float(t.get("premium", 0))
        top = sorted(by_symbol.items(), key=lambda kv: kv[1], reverse=True)[:10]
        lines.append(
            "- Top tickers by options premium in the last "
            f"{len(flow)} market-wide prints: " + ", ".join(f"{s} (${p:,.0f})" for s, p in top)
        )
    return "\n".join(lines)


async def handle_query(query: str) -> str:
    """Entry point for the [[UW: ...]] marker. Expects either the literal
    word MARKET for a broad snapshot, or a single ticker symbol."""
    q = query.strip().strip("$").upper()
    if not q or q == "MARKET":
        return await market_summary()
    ticker = q.split()[0]
    return await ticker_snapshot(ticker)
