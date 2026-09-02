# Signed requests — operator guide

Every request to every block must carry a valid ed25519 signature. There is
no mode that skips verification: `bin/bootstrap-keys` mints a key for each
identity, and a caller without one is refused.

Protocol reference (header format, canonical string, nonce and timestamp
rules): [`SIGNING-PROTOCOL.md`](SIGNING-PROTOCOL.md). This document is the
operator side: which endpoints stay open, how to sign a call by hand, how to
bring an existing deployment onto signing, and where to look when it breaks.

## Always-open endpoints

The middleware never gates these, regardless of mode:

- `GET /health` — Docker healthchecks, monitoring probes
- `GET /metrics` — Prometheus scraping (future)
- HTTP `OPTIONS` preflight — CORS from browsers (cannot be signed)
- WebSocket upgrade handshake on consciousness-server — the shared
  middleware always passes upgrade requests through
  (`lib/verify-signed.js`), in every mode including `enforce`.

**Known limitation — WebSocket is unauthenticated in v1.** The WS
endpoint mounts on the same port with no path filter; an agent
connects to `ws://host:13032/<agent-name>` and the server takes the
agent name from the URL as-is, with no verification of any kind.
Anyone who can reach port 13032 can open a WS connection under any
name and receive push events, regardless of the gate. If that is
unacceptable in your deployment, keep 13032 on loopback or a VPN
interface. WS signing is a future iteration.

If a block needs additional always-open endpoints (e.g. public
read-only status), that's a per-block decision — it lives inside
the block's code, not in the shared middleware.

## Signing a request

See [key-server/keys/agents/README.md](../key-server/keys/agents/README.md)
for the agent-side procedure. TL;DR:

```bash
# From the ecosystem root, with a bootstrapped agent key at
# ~/.ssh/ecosystem-agent1 and agent1.pub already on the key-server:

bin/sign-request agent1 POST /api/notes '{"title":"hello"}'
# → prints four X-* headers. Pass them to curl / your HTTP client.
```

For programmatic signing: `key-server/keys/agents/README.md`
ships Node and Python snippets. Node blocks inside this repo have a
shared module for it — `lib/sign-outbound.js` (`signHeaders()`),
copied into each block's `middleware/`. It is driven by two env vars:
`CS_SIGNING_KEY` (path to an OpenSSH ed25519 private key) and
`CS_AGENT_ID` (identity to sign as, default `cs-core`). With
`CS_SIGNING_KEY` unset the module returns no headers and outbound
calls behave exactly as before signing existed.

## Bringing every caller onto signing

The gate is only as useful as the set of callers that actually sign. This
section is the honest inventory: what signs, what does not, and what to do
about the gap.

### Caller inventory

| Caller → callee | Signs? | How |
|---|---|---|
| consciousness-server → semantic-search `POST /api/embed` (auto-embed of session summaries) | **YES** | `lib/sign-outbound.js`; set `CS_SIGNING_KEY` + `CS_AGENT_ID` on the CS process/container (commented template in `deploy/docker-compose.yml`) |
| Operator / scripts via `bin/sign-request` CLI | **YES** | prints the four `X-*` headers for curl |
| `bin/chat-agent`, `bin/status-collector` | **YES** | each signs through a `bin/sign-request` subprocess |
| Cortex agent → CS API | **YES, after the parallel change in the cortex repo** | same env contract: `CS_SIGNING_KEY` = path to the agent's OpenSSH ed25519 key. Until that lands, its traffic gets 401 |
| WebSocket clients → `ws://…:13032/<agent>` | **NO** — WS has no auth in v1 (see "Known limitation" above) | keep 13032 on loopback / VPN |
| MCP servers calling CS | **NO** | trusted-network assumption for now |
| Skills that shell out to plain curl | **NO** | wrap them with `bin/sign-request` |

Everything in the **NO** rows gets a 401. There is no mode that lets them
through, so either they learn to sign or they stay off the network that can
reach these ports. Do not plan a rollout that assumes otherwise.

### Order of operations

`bin/bootstrap-keys` covers this for identities the deployment already knows
about. Do it by hand when adding an identity that lives on another host:

```bash
# 1. One keypair per signing identity (not per host):
ssh-keygen -t ed25519 -C "cortex@$(hostname)" -f ~/.ssh/ecosystem-cortex -N ""

# 2. Register the PUBLIC half on the key-server host:
scp ~/.ssh/ecosystem-cortex.pub operator@ks-host:/opt/ecosystem/key-server/keys/agents/cortex.pub

# 3. Confirm the identity resolves:
curl -s http://127.0.0.1:13040/api/agents/identity/cortex | jq .fingerprint

# 4. Point the caller at its private half:
#    CS: uncomment CS_SIGNING_KEY / CS_AGENT_ID in deploy/docker-compose.yml
#    and mount the key :ro into the container; recreate the service.
#    Cortex: same env contract in its own unit/config.

```

Register the key **before** the caller starts. A caller that begins running
unsigned is refused from its first request, which is the intended behaviour
and not a rollout window.

### Failure mode worth knowing in advance

If CS has **no** `CS_SIGNING_KEY`, the session-summary auto-embed degrades
quietly: the summary is still stored in Redis and the API still answers 201,
but the embed call gets 401 and the summary never becomes semantically
searchable. The only trace is a `Failed to embed summary to ChromaDB` line in
CS logs. Check that line after configuring a signing client — a 201 does not
prove the chain works.


## When the gate hurts

**key-server down = 503 on every request.** This is deliberate: failing open
would let a compromised key-server, or a DoS that silences it, quietly
de-authenticate the whole ecosystem. It also makes key-server a single point
of failure, and there is no switch to route around it — that is the cost of
having no way to turn verification off. Treat key-server as infrastructure:
restart policy, monitoring on its `/health`, and a tested restore of
`key-server/keys/`.

**Clock skew >300 s = timestamp_out_of_window.** If a
container has lost NTP sync, its signed requests will be rejected
until the clock is back inside the ±300 s window. Fix NTP, don't
widen the window.

**`enforce` + agent keys rotated without key-server refresh =
unknown_agent.** Key rotation procedure is `scp new.pub` + `rm old.pub`
on the key-server host. There's no DB migration; files are the
authority.

## Where to look when it breaks

```bash
# Key-server's own audit log of every verify call:
cat deploy/volumes/key-server-logs/audit.jsonl | tail -50

# Is key-server even reachable from the block's network?
docker compose exec <block> curl -s http://key-server:13040/health

# Is the pub key on the key-server?
curl -s http://127.0.0.1:13040/api/agents/identity/<AGENT> | jq
```

## What the signature does NOT do

- Does not authorize — an authenticated agent is allowed to call
  every endpoint. Per-endpoint authorization (ACL / RBAC) is out
  of scope for this revision.
- Does not encrypt transport — LAN / VPN assumption. Full TLS is
  out of scope for this revision.
- Signs exactly one block-to-block call so far: consciousness-server →
  semantic-search `POST /api/embed` (via `lib/sign-outbound.js`, only
  when `CS_SIGNING_KEY` is set). That is also the only outbound call
  a block in this repo makes to a gated sister endpoint — the other
  outbound traffic is `/health` probes and Ollama, both outside the
  gate. Any future block-to-block call must adopt the same module,
  or it will 401.

## Related docs

- [SIGNING-PROTOCOL.md](SIGNING-PROTOCOL.md) — headers, canonical message, `/api/verify` API, client examples
- [key-server/keys/agents/README.md](../key-server/keys/agents/README.md) — agent bootstrap procedure
