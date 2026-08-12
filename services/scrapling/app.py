"""
Scrapling sidecar — stealth fetch for the pages Crawl4AI cannot reach.

POST /fetch { url, mode?, network_idle?, timeout_ms?, disable_resources? }
       → { status, url, html, size, mode, escalated }

Why this service exists at all
-----------------------------
Crawl4AI >= 0.9 refuses `proxy_config` on a request body (every HTTP body is
Provenance.UNTRUSTED and proxy_config is a forbidden power-field), and pins
Chromium to its own localhost egress proxy. So Crawl4AI can only ever egress
from the platform's own datacenter IP. Measured against LinkedIn profiles, that
IP burns out: 3/6 → 1/6 → 0/6 over 18 sequential fetches, all HTTP 999, and no
amount of retrying helps because the IP itself is what is blocked. This service
owns the residential egress and the challenge solving Crawl4AI cannot have.

Three modes, because the failure modes are different and so are their costs
-------------------------------------------------------------------------
Measured 2026-08-12, same browser engine throughout:

  FAST     direct, no solve, no subresources
           ordinary pages 0.7-1.9s · socialblade 200 · linkedin 999 · trustpilot 403
  STEALTH  residential proxy, no solve
           linkedin 34/36 (94%) @ ~2.9s  (direct decays to 0/6 HTTP 999)
  SOLVE    direct, solve_cloudflare, subresources loaded
           trustpilot 2/2 @ 1.9-4.1s  (vs 0/2 403 without solve)

FAST is the default rather than SOLVE, even though SOLVE is a superset
functionally, because solve_cloudflare is not free and not always bounded:
  - ~2x latency on ordinary pages (gorgias.com 1.9s → 4.0s, HN 0.7s → 1.4s).
  - On a challenge it CANNOT solve it hangs for the entire timeout rather than
    failing fast — measured `Locator.bounding_box: Timeout 120000ms exceeded`
    on a site FAST rejects in 0.3s. Each mode owns a single-slot executor, so
    one such page would block every other request for that mode in this worker.
So we pay for solving only when we see a challenge: an auto-routed request that
comes back looking challenged is retried once in SOLVE (see `escalated`).

Note the Trustpilot 403 is NOT an IP problem — an unproxied fetch from a
residential home IP returned the identical 970-byte "Verifying Connection"
body, so it is the challenge, which is what SOLVE handles. And SOLVE
deliberately does not use the proxy: solving through a rotating residential
exit measured 1/2 with a 32.9s outlier, vs 2/2 at 1.9-4.1s direct.

Scrapling refuses per-fetch `proxy=` overrides and solve_cloudflare is fixed at
session construction, so modes cannot be per-request arguments on one session —
each is its own session, built lazily.

Threading model
---------------
- uvicorn --workers N forks N independent Python processes.
- Each worker lazily builds at most one session PER MODE it actually sees, so a
  worker that only serves FAST pays for one browser, not three.
- Each mode gets its own single-slot ThreadPoolExecutor: Patchright's greenlet
  plumbing requires every call for a session to stay on one OS thread, and a
  shared executor would serialise unrelated modes behind each other.
- Worst case per worker is 3 browsers, so WORKERS is deliberately lower than it
  would be for a single-session service. Budget ~200-300MB per live browser.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from scrapling.engines.toolbelt.proxy_rotation import ProxyRotator
from scrapling.fetchers import StealthySession


PROXY_URL = os.environ.get("PROXY_URL", "")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("scrapling-svc")


class Mode(str, Enum):
    # Direct, no challenge solving, subresources blocked. Fastest; the default.
    FAST = "fast"
    # Residential proxy. For IP-reputation walls (LinkedIn HTTP 999) where the
    # block is *who you are* rather than a challenge to solve.
    STEALTH = "stealth"
    # Direct + solve the JS challenge + load subresources (a challenge needs its
    # own CSS/JS to run). For Cloudflare-style "Verifying Connection" walls.
    SOLVE = "solve"


# Hosts whose correct mode we have measured and which FAST cannot serve at all.
# Everything else starts at FAST and escalates to SOLVE only if it looks
# challenged, so an unlisted host never pays the solve tax up front.
STEALTH_HOSTS = ("linkedin.com",)


def pick_mode(url: str) -> Mode:
    host = (urlsplit(url).hostname or "").lower()
    for suffix in STEALTH_HOSTS:
        if host == suffix or host.endswith("." + suffix):
            return Mode.STEALTH
    return Mode.FAST


# Interstitials that mean "solve the challenge", not "this page is forbidden".
# Matched against the returned body, which is short for a challenge page.
_CHALLENGE_MARKERS = (
    "just a moment",
    "verifying connection",
    "verifying you are human",
    "attention required! | cloudflare",
    "checking your browser",
    "cf-browser-verification",
    "cf_chl_opt",
)


def looks_like_challenge(status: int, html: str) -> bool:
    """A challenge wall we could plausibly solve, as opposed to a hard block.

    Challenge pages are small and carry a known interstitial title; a genuine
    403/404 from the origin does not. Requiring both keeps us from burning a
    120s solve attempt on a page that is simply forbidden.
    """
    if status not in (403, 429, 503):
        return False
    if len(html) > 200_000:  # a real page, not an interstitial
        return False
    lowered = html.lower()
    return any(marker in lowered for marker in _CHALLENGE_MARKERS)


_executors: dict[Mode, ThreadPoolExecutor] = {
    m: ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"scrapling-{m.value}")
    for m in Mode
}
_sessions: dict[Mode, StealthySession] = {}


def _ensure_session_in_worker(mode: Mode) -> StealthySession:
    """Build this mode's session lazily, inside its own worker thread."""
    session = _sessions.get(mode)
    if session is not None:
        return session

    if mode is Mode.STEALTH:
        proxy = parse_proxy(PROXY_URL)
        if proxy is None:
            raise RuntimeError(
                "PROXY_URL must be set as http://user:pass@host:port for mode=stealth"
            )
        s = StealthySession(
            headless=True,
            solve_cloudflare=False,
            proxy_rotator=ProxyRotator(proxies=[proxy]),
        )
    elif mode is Mode.SOLVE:
        s = StealthySession(headless=True, solve_cloudflare=True)
    else:
        s = StealthySession(headless=True, solve_cloudflare=False)

    s.__enter__()
    _sessions[mode] = s
    log.info("session initialised pid=%d mode=%s", os.getpid(), mode.value)
    return s


def parse_proxy(url: str):
    """Convert "http://user:pass@host:port" into Scrapling's dict form."""
    if not url:
        return None
    m = re.match(r"^(https?)://([^:]+):([^@]+)@(.+)$", url)
    if not m:
        return None
    return {
        "server": f"{m.group(1)}://{m.group(4)}",
        "username": m.group(2),
        "password": m.group(3),
    }


def _discard_session(mode: Mode) -> None:
    """Tear down a mode's session so the next request builds a fresh one.

    A raised fetch does not leave a usable session behind: Patchright's sync API
    is driven from this one pinned thread, and once a call blows up mid-flight the
    driver can be left in a state where every subsequent fetch on that session
    hangs instead of erroring. Observed exactly that after Scrapling raised "No
    Cloudflare challenge found" — the service kept accepting connections and
    answering nothing, so callers saw an 85s timeout rather than a failure, and
    the whole sidecar looked dead while the process was fine.

    So an error always costs us the session, never the worker.
    """
    session = _sessions.pop(mode, None)
    if session is None:
        return
    try:
        session.__exit__(None, None, None)
    except Exception as e:  # noqa: BLE001 - teardown must not mask the real error
        log.warning("discarding %s session raised on close: %s", mode.value, e)
    log.info("discarded %s session; next request rebuilds it", mode.value)


def _do_fetch(mode: Mode, req_url: str, network_idle: bool, timeout_ms: int,
              disable_resources: bool) -> dict:
    """Runs inside this mode's single-thread executor."""
    session = _ensure_session_in_worker(mode)
    try:
        page = session.fetch(
            req_url,
            network_idle=network_idle,
            timeout=timeout_ms,
            disable_resources=disable_resources,
        )
    except Exception:
        _discard_session(mode)
        raise
    return {
        "status": page.status,
        "url": page.url,
        "html": page.html_content,
        "size": len(page.html_content),
        "mode": mode.value,
    }


app = FastAPI(title="scrapling-svc", version="1.0.0")


class FetchRequest(BaseModel):
    url: str = Field(..., description="Absolute URL to fetch")
    mode: Mode | None = Field(
        None,
        description="fast = direct (default). stealth = residential proxy, for IP walls "
                    "like LinkedIn. solve = direct + solve the JS challenge, for "
                    "Cloudflare-style walls. Omit to pick by host and auto-escalate to "
                    "solve if the response looks challenged.",
    )
    network_idle: bool = Field(False, description="Wait for network idle before returning")
    disable_resources: bool | None = Field(
        None,
        description="Block images/CSS/fonts. Defaults to False for solve (a challenge needs "
                    "its subresources) and True otherwise.",
    )
    timeout_ms: int = Field(60_000, ge=1_000, le=180_000)


class FetchResponse(BaseModel):
    status: int
    url: str
    html: str
    size: int
    mode: str
    escalated: bool = False


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "pid": os.getpid(),
        "sessions_ready": sorted(m.value for m in _sessions),
        "proxy_configured": bool(PROXY_URL),
    }


# Hard ceiling on any single fetch, independent of the caller's timeout_ms. The
# challenge solver can block well past its own deadline (measured
# `Locator.bounding_box: Timeout 120000ms exceeded`), and each mode has a
# single-slot executor — so one unbounded fetch stalls every later request for
# that mode. Cap it here so the slot always comes back.
MAX_FETCH_MS = 90_000


async def _run(mode: Mode, req: FetchRequest) -> dict:
    disable_resources = (
        req.disable_resources
        if req.disable_resources is not None
        else (mode is not Mode.SOLVE)
    )
    timeout_ms = min(req.timeout_ms, MAX_FETCH_MS)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _executors[mode], _do_fetch, mode, req.url, req.network_idle,
        timeout_ms, disable_resources,
    )


@app.post("/fetch", response_model=FetchResponse)
async def fetch(req: FetchRequest):
    explicit = req.mode is not None
    mode = req.mode or pick_mode(req.url)

    try:
        data = await _run(mode, req)
    except Exception as e:
        log.exception("fetch failed url=%s mode=%s", req.url, mode.value)
        raise HTTPException(status_code=502, detail=f"[{mode.value}] {e}")

    # Only escalate when we chose the mode ourselves — an explicit mode is the
    # caller's decision and we should not silently spend a second fetch on it.
    if (
        not explicit
        and mode is not Mode.SOLVE
        and looks_like_challenge(data["status"], data["html"])
    ):
        log.info("escalating to solve url=%s (status=%s)", req.url, data["status"])
        try:
            solved = await _run(Mode.SOLVE, req)
        except Exception as e:
            # Keep the original response rather than turning a usable 403 body
            # into a 502 — the caller can still inspect it. Scrapling raises "No
            # Cloudflare challenge found" here whenever the wall is some other
            # vendor's, which is common and not fatal; _do_fetch has already
            # discarded the solve session, so the next attempt starts clean.
            log.warning("escalation to solve failed url=%s: %s", req.url, e)
            return FetchResponse(**data, escalated=False)
        return FetchResponse(**solved, escalated=True)

    return FetchResponse(**data, escalated=False)
