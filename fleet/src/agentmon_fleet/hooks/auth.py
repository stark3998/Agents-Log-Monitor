"""Caller authentication for hook endpoints: Entra JWTs (Copilot Studio FIC app / managed identities) or a shared
bearer for local testing."""
from __future__ import annotations

import hmac
import logging
from functools import lru_cache

import jwt
from fastapi import HTTPException, Request

from ..config import Settings

log = logging.getLogger(__name__)


@lru_cache
def _jwks(tenant: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys", cache_keys=True,
                           lifespan=3600)


def authenticate(request: Request, settings: Settings) -> dict:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not token:
        if settings.hooks_allow_anonymous:
            return {"sub": "anonymous"}
        raise HTTPException(401, "missing bearer token")
    if settings.hooks_token and hmac.compare_digest(token, settings.hooks_token):
        return {"sub": "shared-token"}
    tenant = settings.azure_tenant_id
    if not tenant or not settings.hooks_audience:
        raise HTTPException(401, "JWT validation not configured (FLEET_AZURE_TENANT_ID / FLEET_HOOKS_AUDIENCE)")
    try:
        key = _jwks(tenant).get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=settings.hooks_audience,
                            issuer=[f"https://login.microsoftonline.com/{tenant}/v2.0", f"https://sts.windows.net/{tenant}/"],
                            options={"require": ["exp", "iat", "aud", "iss"]}, leeway=60)
    except Exception as exc:
        try:  # unverified peek, only to make audience/issuer mismatches diagnosable
            peek = jwt.decode(token, options={"verify_signature": False})
            log.warning("hook token rejected (%s): aud=%s iss=%s azp=%s", type(exc).__name__, peek.get("aud"),
                        peek.get("iss"), peek.get("azp") or peek.get("appid"))
        except Exception:
            log.warning("hook token rejected: %s", exc)
        raise HTTPException(401, "invalid token") from exc
    caller = claims.get("azp") or claims.get("appid")
    if settings.hooks_allowed_app_ids and caller not in settings.hooks_allowed_app_ids:
        raise HTTPException(403, "caller not allowed")
    return claims
