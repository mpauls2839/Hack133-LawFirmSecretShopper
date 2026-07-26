# Router image for Maritime deployment.
#
# Two things this must get right:
#  1. ca-certificates. The `flue` template image ships an empty /etc/ssl/certs, which
#     makes every HTTPS call fail with "failed to verify the legitimacy of the server".
#     Verified 2026-07-26. We install them explicitly rather than inherit the problem.
#  2. Native build deps for better-sqlite3, which compiles against the Node headers.
#  3. Chromium for the front-door Playwright MCP agent (headless browser first-contact).
#
# Inside a Maritime agent the platform injects OPENAI_BASE_URL and
# OPENAI_API_KEY=mllm_<agentId>_<token>. The judge reads those, so no provider key of
# ours ever has to exist in the image or the environment.

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        make \
        g++ \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libdbus-1-3 \
        libxkbcommon0 \
        libatspi2.0-0 \
        libx11-6 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libpango-1.0-0 \
        libcairo2 \
        libasound2 \
        libxshmfence1 \
        fonts-liberation \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not rebuild native modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install chromium

COPY src ./src
COPY config ./config
COPY public ./public

# The database lives on the agent's persistent workspace disk, not in the image layer.
ENV DB_PATH=/app/data/intake-grader.db
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_MCP_ARGS=@playwright/mcp@latest --headless --isolated
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
