"""HTTP API for the Mini App and the admin console."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from zyron_node.auth import AuthError, TelegramIdentity, admin_authorized, hash_ip, verify_init_data
from zyron_node.buildinfo import CLIENT_BUILD, SHELL_ID
from zyron_node.client_ip import client_address
from zyron_node.economy import LEVEL_CHEST_STEP, POINTS_NOTICE, REFEREE_REWARD, REFERRER_REWARD
from zyron_node.game import (
    GameError,
    achievements_view,
    admin_overview,
    admin_search,
    chests_view,
    claim_streak,
    close_season,
    export_snapshot,
    get_snapshot,
    leaderboard_view,
    link_wallet,
    list_snapshots,
    observe_chain,
    open_chest,
    open_session,
    purchase_upgrade,
    quests_view,
    release_wallet_claim,
    resolve_flag,
    run_cycle,
    set_ban,
    unlink_wallet,
    upgrades_view,
)
from zyron_node.limits import RateLimitExceeded, hit


def error_payload(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


class IdempotentBody(BaseModel):
    idempotencyKey: str = Field(min_length=8, max_length=80)


class UpgradeBody(IdempotentBody):
    module: str = Field(min_length=2, max_length=32)


class WalletBody(IdempotentBody):
    address: str = Field(min_length=43, max_length=43)


class ChestBody(BaseModel):
    id: str = Field(min_length=3, max_length=40, pattern=r"^(daily|quest:[a-z0-9_]+|level:[1-9][0-9]?)$")


class BanBody(BaseModel):
    banned: bool = True


class WalletReleaseBody(BaseModel):
    address: str = Field(min_length=43, max_length=43)


def request_now(request: Request) -> datetime:
    settings = request.app.state.settings
    if settings.allow_test_clock and settings.environment == "test":
        raw = request.headers.get("x-test-now")
        if raw:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def client_ip(request: Request) -> str:
    settings = request.app.state.settings
    peer = request.client.host if request.client is not None else None
    real_ip = request.headers.get("x-real-ip")
    return client_address(
        peer,
        settings.trusted_proxies,
        forwarded_for=request.headers.getlist("x-forwarded-for"),
        forwarded=request.headers.getlist("forwarded"),
        real_ip=real_ip,
    )


def resolve_identity(request: Request, now: datetime) -> TelegramIdentity:
    settings = request.app.state.settings
    header = request.headers.get("authorization", "")
    if header.startswith("tma "):
        return verify_init_data(
            header[4:].strip(),
            settings.telegram_bot_token,
            now,
            settings.init_data_max_age_seconds,
        )
    if settings.dev_auth_bypass and settings.environment != "production":
        raw = request.headers.get("x-dev-telegram-id", "").strip()
        if raw.isdigit() and int(raw) > 0:
            start = request.headers.get("x-dev-start-param")
            return TelegramIdentity(id=int(raw), username=None, display_name=f"Dev {raw}", start_param=start or None)
    raise AuthError("missing", "Open ZYRON NODE from Telegram")


def authorize(request: Request, now: datetime) -> tuple[TelegramIdentity, str]:
    settings = request.app.state.settings
    pool = request.app.state.pool
    ip_hash = hash_ip(client_ip(request), settings.referral_ip_salt)
    try:
        hit(pool, f"ip:{ip_hash}:api", 180, 60, now)
    except RateLimitExceeded:
        raise
    try:
        identity = resolve_identity(request, now)
    except AuthError:
        hit(pool, f"ip:{ip_hash}:authfail", 30, 600, now)
        raise
    return identity, ip_hash


def require_admin(request: Request) -> str:
    settings = request.app.state.settings
    if not settings.admin_token:
        raise GameError("admin_disabled", "Admin API is disabled.", 503)
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.startswith("Bearer ") else ""
    if not admin_authorized(token, settings.admin_token):
        raise AuthError("admin", "Admin authorization failed")
    return "admin"


def limit_user(request: Request, telegram_id: int, scope: str, limit: int, window: int, now: datetime) -> None:
    hit(request.app.state.pool, f"tg:{telegram_id}:{scope}", limit, window, now)


def register_routes(app) -> None:
    @app.get("/healthz")
    def healthz():
        return {"ok": True, "service": "zyron-node"}

    @app.get("/readyz")
    def readyz():
        try:
            with app.state.pool.connection() as conn:
                conn.execute("SELECT 1")
        except Exception:  # noqa: BLE001 — readiness is a boolean
            return JSONResponse({"ok": False}, status_code=503)
        return {"ok": True}

    @app.get("/api/meta")
    def meta():
        settings = app.state.settings
        season = None
        with app.state.pool.connection() as conn:
            row = conn.execute(
                "SELECT id, name, status FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if row:
                season = {"id": int(row["id"]), "name": row["name"], "status": row["status"]}
        pace = max(settings.cycle_min_interval_ms, 1_500)
        return {
            "name": "ZYRON NODE",
            "shell": SHELL_ID,
            "clientBuild": CLIENT_BUILD,
            "pointsNotice": POINTS_NOTICE,
            "devAuth": bool(settings.dev_auth_bypass and settings.environment != "production"),
            "season": season,
            "rpcConfigured": bool(settings.zyron_rpc_url),
            "cycleMinIntervalMs": settings.cycle_min_interval_ms,
            "autoCyclePaceMs": pace,
            "rules": {
                "referralReferrer": REFERRER_REWARD,
                "referralReferee": REFEREE_REWARD,
                "referralMinCycles": settings.referral_min_cycles,
                "referralMinAgeSeconds": settings.referral_min_age_seconds,
                "levelChestStep": LEVEL_CHEST_STEP,
            },
        }

    @app.get("/api/me")
    def me(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "me", 60, 60, now)
        return open_session(request.app.state.pool, identity, ip_hash, now, request.app.state.settings.telegram_bot_username)

    @app.post("/api/cycle")
    def cycle(request: Request, body: IdempotentBody):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "cycle", 40, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        settings = request.app.state.settings
        return run_cycle(
            request.app.state.pool,
            player,
            body.idempotencyKey,
            now,
            min_interval_ms=settings.cycle_min_interval_ms,
            min_cycles=settings.referral_min_cycles,
            min_age=settings.referral_min_age_seconds,
        )

    @app.post("/api/upgrade")
    def upgrade(request: Request, body: UpgradeBody):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "upgrade", 30, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return purchase_upgrade(request.app.state.pool, player, body.module, body.idempotencyKey, now)

    @app.get("/api/upgrades")
    def upgrades(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "upgrades", 60, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return upgrades_view(request.app.state.pool, player, now)

    @app.get("/api/chests")
    def chests(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "chests", 60, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return chests_view(request.app.state.pool, player, now)

    @app.post("/api/chests/open")
    def chests_open(request: Request, body: ChestBody):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "chestopen", 30, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return open_chest(request.app.state.pool, player, body.id, now)

    @app.post("/api/streak/claim")
    def streak(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "streak", 10, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return claim_streak(request.app.state.pool, player, now)

    @app.get("/api/quests")
    def quests(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "quests", 60, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return quests_view(request.app.state.pool, player, now, claim=False)

    @app.post("/api/quests/sync")
    def quests_sync(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "questsync", 30, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return quests_view(request.app.state.pool, player, now, claim=True)

    @app.get("/api/achievements")
    def achievements(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "achievements", 60, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return achievements_view(request.app.state.pool, player)

    @app.get("/api/leaderboard")
    def leaderboard(request: Request, board: str = "daily"):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "board", 60, 60, now)
        player = _player_id(request, identity, ip_hash, now)
        return leaderboard_view(request.app.state.pool, player, board, now)

    @app.get("/api/referral")
    def referral(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "referral", 60, 60, now)
        profile = open_session(
            request.app.state.pool,
            identity,
            ip_hash,
            now,
            request.app.state.settings.telegram_bot_username,
        )
        return profile["player"]["referral"]

    @app.post("/api/wallet/link")
    def wallet_link(request: Request, body: WalletBody):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "wallet", 5, 3600, now)
        player = _player_id(request, identity, ip_hash, now)
        return link_wallet(request.app.state.pool, player, body.address.strip(), body.idempotencyKey, now)

    @app.post("/api/wallet/unlink")
    def wallet_unlink(request: Request, body: IdempotentBody):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "wallet", 5, 3600, now)
        player = _player_id(request, identity, ip_hash, now)
        return unlink_wallet(request.app.state.pool, player, body.idempotencyKey, now)

    @app.get("/api/activity")
    def activity(request: Request):
        now = request_now(request)
        identity, ip_hash = authorize(request, now)
        limit_user(request, identity.id, "activity", 20, 60, now)
        player_id = _player_id(request, identity, ip_hash, now)
        with request.app.state.pool.connection() as conn:
            row = conn.execute("SELECT wallet_address FROM players WHERE id = %s", (player_id,)).fetchone()
        address = row["wallet_address"] if row else None
        panel = request.app.state.chain.panel(address, now)
        return observe_chain(request.app.state.pool, player_id, panel, now)

    @app.get("/api/admin/overview")
    def overview(request: Request):
        require_admin(request)
        return admin_overview(request.app.state.pool)

    @app.get("/api/admin/players")
    def players(request: Request, q: str = ""):
        require_admin(request)
        return admin_search(request.app.state.pool, q)

    @app.post("/api/admin/players/{player_id}/ban")
    def ban(request: Request, player_id: int, body: BanBody):
        actor = require_admin(request)
        return set_ban(request.app.state.pool, player_id, body.banned, actor, request_now(request))

    @app.post("/api/admin/flags/{flag_id}/resolve")
    def flag_resolve(request: Request, flag_id: int):
        actor = require_admin(request)
        return resolve_flag(request.app.state.pool, flag_id, actor, request_now(request))

    @app.post("/api/admin/wallet/release")
    def wallet_release(request: Request, body: WalletReleaseBody):
        actor = require_admin(request)
        return release_wallet_claim(request.app.state.pool, body.address.strip(), actor, request_now(request))

    @app.post("/api/admin/season/snapshot")
    def snapshot(request: Request):
        actor = require_admin(request)
        return export_snapshot(request.app.state.pool, actor, request_now(request))

    @app.get("/api/admin/season/snapshots")
    def snapshots(request: Request):
        require_admin(request)
        return list_snapshots(request.app.state.pool)

    @app.get("/api/admin/season/snapshots/{snapshot_id}")
    def snapshot_get(request: Request, snapshot_id: int):
        require_admin(request)
        return get_snapshot(request.app.state.pool, snapshot_id)

    @app.post("/api/admin/season/close")
    def season_close(request: Request):
        actor = require_admin(request)
        return close_season(request.app.state.pool, actor, request_now(request))


def _player_id(request: Request, identity: TelegramIdentity, ip_hash: str, now: datetime) -> int:
    profile = open_session(
        request.app.state.pool,
        identity,
        ip_hash,
        now,
        request.app.state.settings.telegram_bot_username,
    )
    return int(profile["player"]["id"])


def install_error_handlers(app) -> None:
    @app.exception_handler(GameError)
    async def game_error(_request: Request, exc: GameError):
        response = JSONResponse(error_payload(exc.code, exc.message), status_code=exc.status)
        if exc.retry_after:
            response.headers["Retry-After"] = str(int(exc.retry_after))
        return response

    @app.exception_handler(AuthError)
    async def auth_error(_request: Request, exc: AuthError):
        return JSONResponse(error_payload(exc.code, exc.message), status_code=401)

    @app.exception_handler(RateLimitExceeded)
    async def rate_error(_request: Request, exc: RateLimitExceeded):
        response = JSONResponse(error_payload("rate_limited", "Too many requests. Slow down."), status_code=429)
        response.headers["Retry-After"] = str(exc.retry_after)
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_body(_request: Request, _exc: RequestValidationError):
        return JSONResponse(error_payload("invalid_body", "Request body is invalid."), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException):
        return JSONResponse(error_payload("http", "Request failed."), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def unhandled(_request: Request, exc: Exception):
        import logging

        logging.getLogger("zyron_node").exception("unhandled error")
        return JSONResponse(error_payload("internal", "Something went wrong."), status_code=500)
