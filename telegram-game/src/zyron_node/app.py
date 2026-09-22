"""ASGI application. Migrations run on startup. The process binds the configured host and port."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse

from zyron_node.api import error_payload, install_error_handlers, register_routes
from zyron_node.config import Settings, validate_settings
from zyron_node.db import create_pool, migrate
from zyron_node.logging_setup import setup_logging
from zyron_node.rpc import ChainClient, httpx_fetch

log = logging.getLogger("zyron_node")
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
CSP = (
    "default-src 'self'; "
    "script-src 'self' https://telegram.org; "
    "style-src 'self'; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org"
)


def create_app(settings: Settings) -> FastAPI:
    validate_settings(settings)
    setup_logging(settings.log_level)
    docs = None if settings.environment == "production" else "/docs"
    pool = create_pool(settings.database_url)
    migrate(pool)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        pool.close()

    app = FastAPI(
        title="ZYRON NODE",
        docs_url=docs,
        redoc_url=None,
        openapi_url=None if docs is None else "/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.pool = pool
    app.state.chain = ChainClient(
        base_url=settings.zyron_rpc_url,
        allow_remote=settings.zyron_rpc_allow_remote,
        pool=pool,
        fetch=httpx_fetch,
        redis_url=settings.redis_url,
    )

    @app.middleware("http")
    async def guard(request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > 16_384:
            return JSONResponse(error_payload("too_large", "Request is too large."), status_code=413)
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = CSP
        response.headers["Cache-Control"] = "no-store"
        elapsed = int((time.perf_counter() - started) * 1000)
        log.info("http %s %s %s %sms", request.method, request.url.path, response.status_code, elapsed)
        return response

    register_routes(app)
    install_error_handlers(app)

    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html")

    @app.get("/admin")
    def admin_page():
        return FileResponse(FRONTEND / "admin.html")

    @app.get("/assets/{name}")
    def asset(name: str):
        if name not in {"app.js", "admin.js", "styles.css"}:
            return JSONResponse(error_payload("not_found", "Not found."), status_code=404)
        path = FRONTEND / name
        media = "text/css" if name.endswith(".css") else "text/javascript"
        return FileResponse(path, media_type=media)

    @app.get("/robots.txt")
    def robots():
        return PlainTextResponse("User-agent: *\nDisallow: /\n")

    log.info("zyron node ready %s", settings.redacted())
    return app
