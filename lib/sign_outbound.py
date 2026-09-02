"""Signs outbound service-to-service calls. Protocol: docs/SIGNING-PROTOCOL.md."""

import base64
import hashlib
import os
import secrets
from datetime import datetime, timezone

_key = None
_key_path = None


def _load_key():
    """Load and cache the signing key. Raises if configured but unusable."""
    global _key, _key_path

    path = (os.environ.get("CS_SIGNING_KEY") or "").strip()
    if not path:
        return None
    if _key is not None and _key_path == path:
        return _key or None
    _key_path = path

    try:
        from cryptography.hazmat.primitives.serialization import (
            load_ssh_private_key,
        )
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )

        with open(path, "rb") as fh:
            key = load_ssh_private_key(fh.read(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise TypeError(
                f"key is {type(key).__name__}; only ed25519 is accepted"
            )
        _key = key
    except Exception as err:
        _key = None
        raise RuntimeError(
            f"[sign-outbound] CS_SIGNING_KEY={path} unusable: {err}"
        ) from err
    return _key


def assert_usable():
    """Raises at startup if a key is configured but unloadable, instead of per-request 401s."""
    _load_key()


def agent_id() -> str:
    return (os.environ.get("CS_AGENT_ID") or "").strip() or "cs-core"


def is_configured() -> bool:
    return bool((os.environ.get("CS_SIGNING_KEY") or "").strip())


def sign_headers(method: str, path: str, body=b"") -> dict:
    """Builds the four signing headers; `path` is as the callee sees it, query stripped.

    Returns {} when signing is not configured.
    """
    key = _load_key()
    if key is None:
        return {}

    if isinstance(body, str):
        body = body.encode("utf-8")
    body = body or b""

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    nonce = secrets.token_hex(16)
    clean_path = (path or "/").split("?")[0]
    body_sha256 = hashlib.sha256(body).hexdigest()

    canonical = "\n".join([
        (method or "").upper(),
        clean_path,
        timestamp,
        nonce,
        body_sha256,
    ])
    signature = base64.b64encode(
        key.sign(canonical.encode("utf-8"))
    ).decode("ascii")

    return {
        "X-Agent-Id": agent_id(),
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
    }
