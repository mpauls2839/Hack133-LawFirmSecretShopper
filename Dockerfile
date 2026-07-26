# Router image for Maritime deployment.
#
# Two things this must get right:
#  1. ca-certificates. The `flue` template image ships an empty /etc/ssl/certs, which
#     makes every HTTPS call fail with "failed to verify the legitimacy of the server".
#     Verified 2026-07-26. We install them explicitly rather than inherit the problem.
#  2. Native build deps for better-sqlite3, which compiles against the Node headers.
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
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not rebuild native modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config
COPY public ./public

# The database lives on the agent's persistent workspace disk, not in the image layer.
ENV DB_PATH=/app/data/intake-grader.db
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
