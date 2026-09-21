# Production image for the combined Next.js and FastAPI application.
# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS web-deps
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM web-deps AS web-build
COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26 AS runtime
ARG RELEASE_VERSION=1.2.0
ARG VCS_REF=unversioned
ARG BUILD_DATE=unknown
ARG IMAGE_DIGEST=unavailable
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
    IMAGE_DIGEST=${IMAGE_DIGEST} \
    PRODUCTION_TOOL_RELEASE=${RELEASE_VERSION} \
    MAX_UPLOAD_BYTES=524288000 \
    JOB_TTL_SECONDS=14400 \
    MAX_CONCURRENT_JOBS=2 \
    MAX_ACTIVE_JOBS=20 \
    MAX_TOTAL_JOB_BYTES=5368709120 \
    MAX_JOB_WORK_BYTES=2147483648 \
    MAX_JOB_CREATIONS_PER_MINUTE=30 \
    JOB_DATA_DIR=/data/jobs

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=web-build /usr/local/bin/node /usr/local/bin/node

WORKDIR /app/backend
COPY backend/requirements.txt backend/requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock \
    && pip uninstall --yes pip
COPY backend/app ./app

WORKDIR /app/frontend
COPY --from=web-build /build/frontend/.next/standalone ./
COPY --from=web-build /build/frontend/.next/static ./.next/static
COPY deploy/supervisord.conf /etc/supervisord.conf

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app app \
    && mkdir -p /data/jobs \
    && chown -R app:app /app /data

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/healthz >/dev/null || exit 1

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
