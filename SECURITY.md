# Security

This document describes the threat model consciousness-server is
designed for, the deliberate trade-offs the default configuration
makes, and how to report a vulnerability.

## Intended deployment

consciousness-server assumes **every client that can reach its ports is
trusted**. There is no tenant isolation and no per-user authorisation: any
caller on the network can read and write the shared state of every other
caller. Run it on a network whose membership you control — a LAN, a VPN, or
a host-only interface. It is **not** a public multi-tenant service and is
not hardened against an adversary with arbitrary network access to its
ports.

Concrete assumptions in the default configuration:

- The host Docker daemon and any peers that can reach ports 13032,
  13037, 13038, 13041, 13042, 16380 are trusted. Under `--profile mesh`/
  `full`, this also includes 15432 (`memory-postgres`) — a host port
  that, unlike the others, is not driven by `ports.yaml` but by
  `MEMORY_PG_HOST_PORT` in `deploy/.env`, so retuning the registry does
  not move it.
- Every call must carry a valid
  ed25519 signature. This authenticates *which identity* is calling; it
  does not partition what that identity may touch. Every holder of a key
  reaches the same shared state.
- Agents launched under one operating-system account share that account's
  credentials and filesystem access.
- Port 13040 (key-server, opt-in) is expected to be reachable only
  from the other blocks in the ecosystem. Do not expose it publicly.

Request signing authenticates network requests; it does not isolate local
processes that share an operating-system account. See the key-isolation
boundary below.

## Deliberate trade-offs (not bugs)

These behaviours are **by design**. If you find one surprising,
this section explains why.

### Agent signatures assume a trusted local account

`bin/bootstrap-keys` stores each private agent key under `deploy/keys/` with
mode `0600`, owned by the operator running the launchers. This prevents other
Linux users from reading the key. It does **not** distinguish processes running
under that same user: any such process can open another agent's private key and
produce a signature carrying that agent's ID.

In the shipped single-operator layout, a valid signature therefore proves that
the caller had access to the named key. It provides useful attribution between
cooperating processes and rejects network callers that do not have the key; it
is not proof that one particular local agent process produced the request.
Request signing does not strengthen this local boundary.

Do not run mutually untrusted agents under one Linux account and treat their
signatures as isolation. That guarantee requires a deployment architecture not
shipped here: for example, separate OS principals or containers with access to
only one private key, or a non-exportable signing broker that authenticates the
calling process before signing.

### Agent-to-agent orchestration via tmux

`POST /api/agents/:name/restart` on consciousness-server sends
`C-c` + `claude` + `Enter` into a tmux session named after the
target agent. This is an **intentional orchestration channel** —
it lets a supervisor agent (like an observer / reviewer role) restart a
stuck peer without manual intervention.

The endpoint validates the agent name against `[A-Za-z0-9._-]+` and
invokes tmux via `execFile` with an argv array (no shell
interpolation), so the attack surface is limited to what tmux
itself exposes. But an agent that can reach CS at all can also
restart other registered agents by design. The signature says which
identity asked; it does not say the identity was allowed to.

### systemctl service control on consciousness-server

`POST /api/system/services/:name/:action` lets a caller
start/stop/restart/enable/disable a systemd **user** unit. The
`action` is validated against an allowlist; the `name` is validated
against `[a-zA-Z0-9._@:-]+` and invoked via `execFile`. But it is
still a control surface — do not enable it on a host where the
Linux user running CS can touch units you do not want a network
caller to reach.

`GET /api/system/services/:name/logs` additionally exposes
`journalctl --user` output for a unit. The `name` is validated
against the same systemd-unit pattern, the `lines` query parameter
is bounded to 1–10000, and journalctl is invoked via `execFile`
(argv array, no shell). It is still a read surface over user-unit
logs — anything the CS Linux user can read via `journalctl --user`
becomes readable to any caller holding a valid key.

### Key-server secrets dispenser

`GET /keys/ssh/:name` and `GET /keys/api/:service` on key-server
hand out SSH private keys and stored API keys over HTTP. This is
convenient for a single-user deployment that wants one place to
rotate credentials; it is **unsafe on a reachable network**.

Protections in place:
- IP allowlist (CIDR-style prefix match), always on
- Sensitive endpoints (`/keys/*`, `/audit`)
  require an ed25519-signed request — same protocol the rest of the
  ecosystem uses, verified locally against `keys/agents/<AGENT>.pub`.
  Revoke a caller by `rm keys/agents/<AGENT>.pub`; no tokens to rotate.
- Every request is audit-logged, split across two files under
  `deploy/volumes/key-server-logs/`: dispenser accesses
  (`/keys/ssh/*`, `/keys/api/*`) go to the plain-text `audit.log`;
  `verify` and `sensitive_gate` events go to the structured
  `audit.jsonl`

If you use this dispenser, keep port 13040 on loopback or a VPN
interface, and rotate keys the moment the host is compromised.

### Query string is outside the signature

The ed25519 canonical message is `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)`
— `PATH` is always the query-stripped path (`core/middleware/verify-signed.js:243`,
`(req.url || '/').split('?', 1)[0]`; the Go client's `canonical()`,
`tui/internal/api/signing.go:120-134`, has no field for it at all). This is
documented in `docs/SIGNING-PROTOCOL.md` ("Why not include query string?");
this section states what it costs.

**Consequence:** a validly-signed `GET` can have its query parameters
rewritten in transit without invalidating the signature. `core/server.js`
uses `req.query.*` for filtering and pagination across many endpoints —
`agent`, `project`, `status`, `since`, `limit`, `offset`, `type`, `tag`
among them. A signature on `GET /api/logs?agent=WRITER` says nothing about
whether the request that arrives still says `WRITER` — an on-path party
could change it to `agent=BUILDER`, or turn `limit=10` into `limit=100000`,
and the request still verifies. The signature authenticates *who is asking*
and *what path/body they asked with*, not *what they filtered for*.

Extending the canonical format to cover query strings is a protocol version
change — it touches the Node verifier in `lib/`, which every block links to,
the Go signer, and key-server's verification, all at once. See the
design-decisions section of `docs/SIGNING-PROTOCOL.md`.

### Requests are signed, always

A fresh clone comes up with request signing on, and `bin/bootstrap-keys`
mints the keys that make it work.

The one mode that does not refuse anything is `observe`: it logs what
`enforce` would have rejected and serves the request anyway. A block left
in `observe` is unauthenticated in every practical sense — use it only
while migrating callers that are already running, and check that nothing
stayed there. `docs/SIGNED-REQUESTS.md` walks through it.

## What this document does NOT cover

- Authorisation between authenticated agents. An agent that
  successfully authenticates (under `enforce`) is trusted on
  every endpoint. Per-endpoint ACL/RBAC is not in v1.
- Transport encryption. LAN / VPN is assumed. Ports are plaintext
  HTTP. TLS is not in v1.
- Protection against a compromised block. If key-server is taken
  over, every signed request can be forged. If Redis is taken
  over, every stored memory can be tampered. Isolation between
  blocks is container-level, not trust-level.
- Supply-chain attacks on dependencies. Direct deps live as caret
  ranges in `*/package.json` and lower-bound pins in
  `*/requirements.txt` / `bin/requirements.txt`. Exact resolved
  versions are locked in tracked `package-lock.json` files and
  `npm ci` enforces them at build time, but the lockfiles are not
  audited per release.

## Reporting a vulnerability

Please report security issues **privately**, not in public GitHub
issues.

- **Email:** buildonai.tm@gmail.com

Include:

1. A clear description of the issue and its impact
2. Steps to reproduce (ideally a minimal PoC)
3. Your preferred credit / disclosure terms

Expect an acknowledgement within a few business days. For critical
issues (remote code execution, auth bypass, secret disclosure), a
fix or mitigation advisory will be prioritised over any other work.
Non-critical issues are handled on a best-effort basis.

There is no bug bounty programme today.

## Hardening checklist for operators

If you deploy consciousness-server somewhere that is not "a laptop
on my desk":

- [ ] Run `bin/bootstrap-keys` and confirm every caller has a key
      before it starts; an unregistered caller is refused, not warned.
- [ ] Run key-server under `--profile full`; never expose port 13040
      outside the ecosystem network.
- [ ] Bind the public ports (13032, 13037, 13038, 13041, 13042) to
      loopback or a VPN interface, not `0.0.0.0`, unless you
      actually want remote access.
- [ ] Back up `deploy/volumes/redis/` and `deploy/volumes/chroma/`
      on a schedule — they contain all the durable state.
- [ ] Do not drop real SSH private keys into `key-server/keys/ssh/`
      on a deployment where multiple people can reach port 13040.
      Consider a proper secret manager (Vault, 1Password CLI, AWS
      Secrets Manager) instead of the built-in dispenser.
- [ ] Review `docs/SIGNED-REQUESTS.md` and `docs/SIGNING-PROTOCOL.md`
      before enabling enforcement in production.
- [ ] If agents are not mutually trusted, isolate their OS principals and
      private-key access; request signing alone does not isolate processes
      sharing one Linux account.
