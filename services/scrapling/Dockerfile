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
# Downloads ~200 MB of Camoufox + Patchright binaries into the image so
# the runtime container starts fast and offline.
RUN scrapling install

COPY app.py .

# WORKERS is lower than a single-session service would want: each worker can
# lazily build up to one browser PER MODE (fast / stealth / solve), so the
# worst-case browser count is WORKERS * 3 at ~200-300MB each. 3 workers keeps
# that inside a ~2GB container while still serving the three modes in parallel.
ENV PORT=8000 WORKERS=3
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
