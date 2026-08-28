# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Build — install deps, type-check, and produce the production build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies first (leverages Docker layer caching on package.json)
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source
COPY . .

# Type-check as part of the image build (fails the build on type errors)
RUN npm run typecheck

# Production Vite build -> /app/dist
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Runtime — minimal nginx serving only the compiled static assets
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Metadata for traceability (populated at build time via build args)
ARG IMAGE_CREATED="unknown"
ARG IMAGE_REVISION="unknown"
ARG IMAGE_VERSION="unknown"
LABEL org.opencontainers.image.created="${IMAGE_CREATED}"
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}"
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"
LABEL org.opencontainers.image.title="tofan-cloud"

# Remove the default nginx site and any default content
RUN rm -f /etc/nginx/conf.d/default.conf \
    && rm -rf /usr/share/nginx/html/*

# Ship only the compiled build output + our nginx configuration.
# No node_modules, source code, package manifests, or build tooling is included.
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf

# Run nginx as a non-root user with a writable temp/cache dir (production hardening)
RUN touch /var/run/nginx.pid \
    && chown -R nginx:nginx /var/run/nginx.pid \
    && chown -R nginx:nginx /var/cache/nginx \
    && chown -R nginx:nginx /var/log/nginx \
    && chown -R nginx:nginx /usr/share/nginx/html

USER nginx

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=8s --retries=12 \
    CMD wget -q -O - http://127.0.0.1/healthz || exit 1

STOPSIGNAL SIGQUIT