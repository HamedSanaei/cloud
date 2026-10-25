# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Build — install deps, type-check, lint, run unit tests, compile
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

# Native deps (argon2) need build tools in this stage only.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY eslint.config.js ./
COPY src ./src
COPY drizzle ./drizzle

# Quality gates inside the image build
RUN npm run typecheck
RUN npm run lint

# Production compile -> /app/dist
RUN npm run build

# Drop dev dependencies (keeps argon2's compiled binary)
RUN npm prune --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: Runtime — Node 24, only compiled output + prod node_modules
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Non-root user
RUN addgroup -S -g 10001 cloud && adduser -S -u 10001 -G cloud cloud

# node_modules (production-only, with native binaries from the build stage)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
# SQL migrations are shipped so the container can run explicit migrations.
COPY --from=build /app/drizzle ./drizzle

# Metadata for traceability
ARG IMAGE_CREATED="unknown"
ARG IMAGE_REVISION="unknown"
ARG IMAGE_VERSION="unknown"
LABEL org.opencontainers.image.created="${IMAGE_CREATED}"
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}"
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"
LABEL org.opencontainers.image.title="cloud-server-backend"
LABEL io.servercloud.platform-contract="1"

USER cloud

EXPOSE 8000

HEALTHCHECK --interval=20s --timeout=4s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8000')+'/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# The default command runs the API. The worker uses `npm run start:worker`.
CMD ["npm", "run", "start"]