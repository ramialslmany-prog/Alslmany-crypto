# One image, one service, one URL: FastAPI serves the API under /api and mounts
# the static frontend at /, so there is no second origin and no CORS to get
# wrong in production.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# Dependency metadata alone, against a stub package, so the layer that resolves
# and downloads every dependency is cached across any change that does not touch
# pyproject.toml — which is nearly every change.
COPY backend/pyproject.toml backend/pyproject.toml
RUN mkdir -p backend/app && touch backend/app/__init__.py \
 && pip install -e ./backend

# app.main resolves the frontend as parents[2]/frontend, so the image has to
# keep the repository's own two-directory layout rather than flattening it.
COPY backend/ backend/
COPY frontend/ frontend/

# Non-root: the container never needs to write outside its own data directory,
# and a compromised process should not be able to.
RUN mkdir -p /srv/data && useradd --system --uid 10001 alslmany \
 && chown -R alslmany:alslmany /srv
USER alslmany

# Overridden by the platform's own value in every deployment below; the default
# is here so `docker run -p 8000:8000` works with no arguments.
ENV PORT=8000
EXPOSE 8000

# Shell form on purpose: $PORT is assigned by the host at start time, and exec
# form would pass the literal string.
CMD exec uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port "$PORT"
