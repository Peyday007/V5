# The Brain, as one deployable container.
#
# One process serves both halves, which is the smallest thing that actually
# works here rather than the smallest thing that sounds modern. Two reasons,
# both from the code rather than from taste:
#
#   * the client calls the API with same-origin relative paths, and the server
#     already serves the built SPA in production. One origin means no CORS, no
#     API base URL to configure, and no second thing to deploy or keep in step.
#   * the app uses Server-Sent Events for audit and research progress. That
#     needs a long-running process holding an open response, which rules out
#     request/response serverless runtimes regardless of anything else.
#
# Nothing authoritative lives in this image. The database is Postgres and the
# documents are in a bucket; the container is disposable and can be replaced at
# any time without losing a row or a byte.

# ---------------------------------------------------------------------------
# Build: install everything, compile the client.
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY client ./client
COPY server ./server

# Typechecks and then builds; a type error fails the image rather than the deploy.
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime: production dependencies, the server, and the built client.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

# Reading a scanned page needs a rasteriser and a recogniser. Without them Brain
# does not guess: it reports those pages unreadable and says which tool is
# missing. They are installed here so a scanned PDF is evidence rather than a
# gap — the extra image size buys a capability the platform otherwise reports as
# absent.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-eng \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY server ./server
# The operator tools run *inside* the deployment, because that is the only place
# that can both mint a test principal and reach the public URL. See
# scripts/verify-hosted.ts for why that combination is the whole point.
COPY scripts ./scripts
COPY --from=build /app/client/dist ./client/dist

# Not root. The process needs no privilege: it opens a socket and talks to two
# network services.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# `data/` still exists because local mode is a supported way to run this image,
# and because the OCR pipeline writes scratch files. In cloud mode nothing
# authoritative is kept here — losing this directory loses nothing.
ENV BRAIN_DATA_DIR=/app/data

# The host tells us the port; 8080 is the fallback for a plain `docker run`.
ENV PORT=8080
EXPOSE 8080

# Liveness only, and deliberately unauthenticated: a platform probe should not
# need to hold a secret, and this answers "is the process up" without naming
# the project, the database or the bucket. Readiness lives at /api/health,
# behind the access gate, because it says where this Brain's data is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node directly, not through npm — and that is not a style choice.
#
# `npm start` does not forward SIGTERM to its child. Measured, not assumed: the
# process exits, but the server never sees the signal, so it never closes the
# listener, never drains the extraction and research queues, and never closes
# the database. Every redeploy would abandon in-flight work that the shutdown
# path exists to finish, and leave extraction runs to be recovered as
# INTERRUPTED at the next boot.
#
# Exec form, so this is PID 1 and receives the signal itself.
CMD ["node", "--import", "tsx", "server/index.ts"]
