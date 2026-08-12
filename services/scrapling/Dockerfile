FROM python:3.13-slim

# Camoufox + Patchright (the stealth Firefox build Scrapling uses) needs
# the standard Playwright system deps. Install once at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg curl ca-certificates \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
    libgdk-pixbuf-2.0-0 libasound2 libxshmfence1 libx11-xcb1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Downloads the browser binaries into the image so the runtime container starts
# fast and offline.
#
# BOTH commands are required, and `scrapling install` alone is not enough:
# StealthySession on 0.4.x drives Patchright's Chromium, which `scrapling
# install` does not fetch. Without the second line the container starts clean and
# then fails every fetch at runtime with
#   BrowserType.launch_persistent_context: Executable doesn't exist at
#   /root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
# which is a 502 per request, not a failed build. Re-check this if the pinned
# Scrapling version changes engines again.
RUN scrapling install \
 && patchright install chromium \
 && patchright install-deps chromium

COPY app.py .

# WORKERS is lower than a single-session service would want: each worker can
# lazily build up to one browser PER MODE (fast / stealth / solve), so the
# worst-case browser count is WORKERS * 3 at ~200-300MB each. At 3 workers that
# is up to 9 live browsers, which is more than this container's memory wants;
# 2 keeps the worst case near ~1.5GB while still serving requests in parallel.
ENV PORT=8000 WORKERS=2
EXPOSE 8000
# Bind to 0.0.0.0. Railway's edge router talks IPv4 to the container
# (so an IPv6-only bind returns 502), and Railway's private DNS for
# *.railway.internal returns both A and AAAA records so sibling services
# can still reach us over the private network.
#
# --workers ${WORKERS} runs N independent Python processes, each owning
# one StealthySession lazily on first request. Patchright's sync API
# can't coexist with FastAPI's asyncio loop in the same process, so
# parallelism is achieved across processes rather than within.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers ${WORKERS}"]
