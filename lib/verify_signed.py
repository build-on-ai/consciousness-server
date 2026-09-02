"""Enforces signed requests on inbound calls. Protocol: docs/SIGNING-PROTOCOL.md."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
from typing import Any, Callable, Mapping
from urllib import error as _urlerror
from urllib import request as _urlrequest

_LOG = logging.getLogger("verify_signed")

KEY_SERVER_URL = (os.environ.get("KEY_SERVER_URL") or "http://key-server:3040").rstrip("/")
VERIFY_TIMEOUT_S = float(os.environ.get("AUTH_VERIFY_TIMEOUT", "2.0"))


_ALWAYS_OPEN_PATHS = frozenset({"/health", "/metrics"})


def _body_sha256(body_bytes: bytes | None) -> str:
    return hashlib.sha256(body_bytes or b"").hexdigest()


def _header(headers: Mapping[str, str], name: str) -> str | None:
    if hasattr(headers, "get"):
        v = headers.get(name)
        if v is not None:
            return v
    lname = name.lower()
    for k, v in headers.items():
        if k.lower() == lname:
            return v
    return None


def verify_signed_request(
    headers: Mapping[str, str],
    method: str,
    path: str,
    body_bytes: bytes | None,
) -> dict:
    """Asks key-server whether this request is authentic.

    Returns {'valid': True} or {'valid': False, 'reason': <str>}; reasons are
    missing_headers, key_server_unreachable, or one key-server itself returns.
    """
    agent_id = _header(headers, "X-Agent-Id")
    timestamp = _header(headers, "X-Timestamp")
    nonce = _header(headers, "X-Nonce")
    signature = _header(headers, "X-Signature")

    if not (agent_id and timestamp and nonce and signature):
        return {"valid": False, "reason": "missing_headers"}

    payload = {
        "agent_id": agent_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "method": method.upper(),
        "path": path,
        "body_sha256": _body_sha256(body_bytes),
        "signature": signature,
    }
    data = json.dumps(payload).encode("utf-8")
    req = _urlrequest.Request(
        f"{KEY_SERVER_URL}/api/verify",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with _urlrequest.urlopen(req, timeout=VERIFY_TIMEOUT_S) as resp:
            body = resp.read()
            parsed = json.loads(body.decode("utf-8"))
    except _urlerror.HTTPError as http_err:
        try:
            parsed = json.loads(http_err.read().decode("utf-8"))
        except Exception:
            return {"valid": False, "reason": f"key_server_http_{http_err.code}"}
        return {
            "valid": bool(parsed.get("valid")),
            "reason": parsed.get("reason") or f"key_server_http_{http_err.code}",
        }
    except (_urlerror.URLError, TimeoutError, OSError):
        return {"valid": False, "reason": "key_server_unreachable"}
    except Exception as err:
        return {"valid": False, "reason": f"key_server_error: {err.__class__.__name__}"}

    if parsed.get("valid") is True:
        return {"valid": True, "agent_id": parsed.get("agent_id") or agent_id}
    return {"valid": False, "reason": parsed.get("reason") or "invalid"}


def _should_skip(method: str, path: str) -> bool:
    if method.upper() == "OPTIONS":
        return True
    if path in _ALWAYS_OPEN_PATHS:
        return True
    return False


def flask_middleware(app: Any) -> None:
    """Attaches the gate as a before_request hook; call once, at the block's top level."""
    from flask import jsonify, request

    @app.before_request
    def _verify_signed_gate():  # noqa: ANN001  (Flask signature)
        if _should_skip(request.method, request.path):
            return None

        verdict = verify_signed_request(
            request.headers,
            request.method,
            request.path,
            request.get_data(cache=True),
        )

        if verdict.get("valid"):
            return None

        reason = verdict.get("reason") or "invalid"

        status = 503 if reason == "key_server_unreachable" else 401
        return jsonify({"error": "unauthorized", "reason": reason}), status


def stdlib_gate(handler_method: Callable) -> Callable:
    """Decorator running the gate before a BaseHTTPRequestHandler method.

    On reject writes 401 or 503 and returns; on pass delegates to the original.
    """
    def _wrapped(self, *args, **kwargs):
        method = self.command or "GET"
        path = (self.path or "/").split("?", 1)[0]

        if _should_skip(method, path):
            return handler_method(self, *args, **kwargs)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        body_bytes = self.rfile.read(length) if length > 0 else b""
        self.rfile = io.BytesIO(body_bytes)
        self._verify_signed_body = body_bytes  # type: ignore[attr-defined]

        verdict = verify_signed_request(self.headers, method, path, body_bytes)

        if verdict.get("valid"):
            return handler_method(self, *args, **kwargs)

        reason = verdict.get("reason") or "invalid"

        status = 503 if reason == "key_server_unreachable" else 401
        payload = json.dumps({"error": "unauthorized", "reason": reason}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        return None

    _wrapped.__name__ = getattr(handler_method, "__name__", "wrapped")
    _wrapped.__doc__ = handler_method.__doc__
    return _wrapped


__all__ = [
    "KEY_SERVER_URL",
    "verify_signed_request",
    "flask_middleware",
    "stdlib_gate",
]
