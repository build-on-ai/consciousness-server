#!/usr/bin/env python3
"""ports — single source of truth for ecosystem port numbers.

Usage:  ports.py <service-name> [fallback]

Precedence, highest first: PORT, PORT_<NAME>, ports.yaml, the caller's fallback.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

_CACHE: dict[str, int] | None = None


def _find_ports_file() -> str | None:
    env = os.environ.get("CS_PORTS_FILE")
    if env:
        return env
    here = Path(__file__).resolve().parent
    for _ in range(6):
        candidate = here / "ports.yaml"
        if candidate.is_file():
            return str(candidate)
        if here.parent == here:
            break
        here = here.parent
    return None


_LINE_RE = re.compile(r"^([A-Za-z][\w-]*)\s*:\s*(\d+)\b")
_TOPKEY_RE = re.compile(r"^([A-Za-z][\w-]*)\s*:\s*$")


def _load_ports() -> dict[str, int]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    path = _find_ports_file()
    if not path:
        _CACHE = {}
        return _CACHE
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        _CACHE = {}
        return _CACHE
    out: dict[str, int] = {}
    in_ports = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0]
        stripped = line.strip()
        if not stripped:
            continue
        m_top = _TOPKEY_RE.match(stripped)
        if m_top:
            in_ports = m_top.group(1) == "ports"
            continue
        if in_ports:
            m = _LINE_RE.match(stripped)
            if m:
                out[m.group(1)] = int(m.group(2))
    _CACHE = out
    return _CACHE


def get_port(service_name: str, fallback: int | None = None) -> int:
    """Resolve the port for ``service_name`` (see precedence in module docstring)."""
    env_specific = os.environ.get(
        "PORT_" + service_name.upper().replace("-", "_")
    )
    if env_specific:
        try:
            return int(env_specific)
        except ValueError:
            pass

    if (
        os.environ.get("PORT")
        and os.environ.get("_CS_PORT_OWNER") == service_name
    ):
        try:
            return int(os.environ["PORT"])
        except ValueError:
            pass

    cfg = _load_ports()
    if service_name in cfg:
        return cfg[service_name]

    if fallback is not None:
        return int(fallback)

    raise RuntimeError(
        f"ports: no entry for {service_name!r} "
        f"(no PORT_{service_name.upper()} env, no ports.yaml entry, no fallback)"
    )


def own_port(service_name: str, fallback: int | None = None) -> int:
    """Resolves the port for a block that owns the generic PORT var."""
    p = os.environ.get("PORT")
    if p:
        try:
            return int(p)
        except ValueError:
            pass
    return get_port(service_name, fallback)


def _main(argv: list[str]) -> int:
    """Command-line face of this module, so shell scripts need no port of their own.

    Prints the resolved port, or the fallback; exits 2 when there is neither.
    """
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__ or "", file=sys.stderr)
        print("usage: ports.py <service-name> [fallback]", file=sys.stderr)
        return 2

    name = argv[0]
    fallback = int(argv[1]) if len(argv) > 1 else None
    try:
        print(get_port(name, fallback))
    except (RuntimeError, ValueError) as exc:
        print(f"ports.py: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
