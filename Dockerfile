# Production image for the combined Next.js and FastAPI application.
# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

FROM node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f AS web-deps
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM web-deps AS web-build
COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM cgr.dev/chainguard/wolfi-base@sha256:88a20e2d017bd20cdc0cb3910de603e7bea9512a6c351a8dd3c9df212ab03d73 AS runtime-base
RUN apk upgrade --no-cache \
    && apk add --no-cache \
        python-3.14-base=3.14.8_git20261021-r3 \
        sqlite-libs=3.54.1-r0 \
        curl=8.23.0-r2 \
        ca-certificates=20261020-r0 \
        libstdc++=16.2.0-r2 \
    && addgroup -S -g 999 app \
    && adduser -S -D -H -u 999 -G app app \
    && mkdir -p /data/jobs \
    && chown -R app:app /data

FROM runtime-base AS python-deps
RUN apk add --no-cache py3.14-pip=26.2.2-r2
WORKDIR /build/backend
COPY backend/requirements.txt backend/requirements.lock ./
RUN python3.14 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --require-hashes -r requirements.lock \
    && /opt/venv/bin/python -m pip uninstall --yes pip

FROM runtime-base AS runtime
ARG RELEASE_VERSION=2.0.3
ARG VCS_REF=unversioned
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Production Tool" \
    org.opencontainers.image.description="Internal CSV preparation tool for RFP ranges and privilege logs" \
    org.opencontainers.image.version="${RELEASE_VERSION}" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.licenses="MIT"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    APP_VERSION=${RELEASE_VERSION} \
    BUILD_ID=${VCS_REF} \
    SOURCE_REVISION=${VCS_REF} \
    REQUIRE_IMAGE_DIGEST=1 \
    PRODUCTION_TOOL_RELEASE=${RELEASE_VERSION} \
    MAX_UPLOAD_BYTES=524288000 \
    JOB_TTL_SECONDS=14400 \
    MAX_CONCURRENT_JOBS=2 \
    MAX_ACTIVE_JOBS=20 \
    MAX_TOTAL_JOB_BYTES=5368709120 \
    MAX_JOB_WORK_BYTES=2147483648 \
    MAX_JOB_CREATIONS_PER_MINUTE=30 \
    JOB_DATA_DIR=/data/jobs \
    SQLITE_TMPDIR=/data/jobs/.sqlite-tmp \
    PATH="/opt/venv/bin:${PATH}"

COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=python-deps /opt/venv /opt/venv
COPY deploy/release-metadata.json /app/release-metadata.json
COPY deploy/verify_runtime.py /app/verify_runtime.py

WORKDIR /app/backend
COPY --from=python-deps /build/backend/requirements.txt /build/backend/requirements.lock ./
COPY backend/app ./app

WORKDIR /app/frontend
COPY --from=web-build /build/frontend/.next/standalone ./
COPY --from=web-build /build/frontend/.next/static ./.next/static
COPY deploy/supervisord.conf /etc/supervisord.conf
COPY deploy/http-proxy.cjs /app/http-proxy.cjs

RUN chown -R app:app /app

USER app
RUN python /app/verify_runtime.py
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/healthz >/dev/null || exit 1

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
