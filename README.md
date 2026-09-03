# consciousness-server

A local coordination layer for AI agents: shared state, tasks, notes, chat,
semantic search over that memory, document ingest, and machine telemetry.
Every request between blocks carries an ed25519 signature; there is no setting
that turns verification off.

## Blocks

| Block | Language | Role |
|---|---|---|
| `core/` | Node.js | HTTP + WebSocket API: agents, tasks, notes, chat, skills. State in Redis. |
| `key-server/` | Node.js | Verifies signed requests, holds agent public keys. |
| `semantic-search/` | Python | ChromaDB index, embeddings from Ollama. |
| `machines-server/` | Python | Machine and service status. |
| `test-runner/` | Python | Runs a project's test suite on request, reports the result. |
| `git-workflow/` | Python | Records commits reported by a post-commit hook. |
| `memory-server/` | Node.js | Document ingest into PostgreSQL with pgvector. Opt-in. |
| `tui/` | Go | Terminal interface over the API. |
| `clients/mcp-buildonai/` | TypeScript | MCP client. |

`ports.yaml` assigns ports. `services.yaml` is the service registry — `/api/services`
reads it at request time, so adding a service there needs no code change.
`agents/*.md` are A2A role cards and `skills/*.md` skill definitions; the core
loads both at startup. Both ship as `_example` / `-example` files: they are
working defaults meant to be replaced with your own.

## Requirements

Docker with Compose, and Ollama reachable on the host at `localhost:11434`.
Ports 13032, 13037, 13038, 13040, 13041, 13042 and 16380 must be free — change them in
`ports.yaml` if they are not.

## Install and run

Every command below shows the directory it runs in. Two of the steps are done
from the checkout root and one from `deploy/` — mixing them up is the most
common way to get `no such file or directory`.

Running the stack writes into the checkout: `deploy/keys/`, `deploy/.env`,
`deploy/volumes/` and `node_modules/`. Work on a copy if you want the checkout
to stay clean.

### 1. Mint the signing keys — from the checkout root

Without keys every call is refused, by design.

```console
~/cs$ bin/bootstrap-keys

Identities in this deployment:
  mint    OBSERVER_EXAMPLE       SHA256:cjqhhc5Wrmv+6mu/FgUSuL0V2h0XDbdzxzdnFSGbmkU
  mint    consciousness-server   SHA256:vkqZ+2LH1sprYU79TvkHdfAt5qvA8DxL3qB5kZr8+88
  mint    key-server             SHA256:Y6XCUi0CPGqBiNS3lS1ugZA3GPJzXL5B62S2hty4MNc
  ...

Key-server access:
  write   key-server             allowlist seeded from .example

23 identities, 23 public keys on file
```

Private keys land in `deploy/keys/`, public keys in `key-server/keys/agents/`.
Neither directory is committed.

### 2. Install the CLI dependency — from the checkout root

`bin/sign-request`, `bin/cs-curl` and `bin/test-endpoints` sign through `sshpk`,
which lives in the key-server package. One command, once:

```console
~/cs$ (cd key-server && npm install)
added 17 packages in 636ms
```

Skip this and the tools stop with `sshpk not found in .../key-server/node_modules`.

### 3. Start the stack — from `deploy/`

```console
~/cs$ cd deploy
~/cs/deploy$ docker compose up -d --build

 ✔ Image cs-ecosystem-semantic-search      Built
 ✔ Image cs-ecosystem-consciousness-server Built
 ✔ Image cs-ecosystem-key-server           Built
 ✔ Image cs-ecosystem-machines-server      Built
 ✔ Image cs-ecosystem-test-runner          Built
 ✔ Image cs-ecosystem-git-workflow         Built
 ✔ Container cs-redis                      Healthy
 ✔ Container cs-semantic-search            Started
 ✔ Container cs-machines-server            Started
 ✔ Container cs-test-runner                Started
 ✔ Container cs-git-workflow               Started
 ✔ Container cs-key-server                 Started
 ✔ Container cs-server                     Started
```

Use `--build` on the first run and after pulling changes. Without it Docker
reuses whatever image is cached, which can be older than the checkout.

### 4. Check that it is up — from `deploy/`

```console
~/cs/deploy$ docker compose ps --format 'table {{.Name}}\t{{.Status}}'

NAME                 STATUS
cs-git-workflow      Up About a minute (healthy)
cs-key-server        Up About a minute (healthy)
cs-machines-server   Up About a minute (healthy)
cs-redis             Up About a minute (healthy)
cs-semantic-search   Up About a minute (healthy)
cs-server            Up About a minute (healthy)
cs-test-runner       Up About a minute (healthy)
```

```console
~/cs/deploy$ curl -s http://localhost:13032/health

{"status":"ok","uptime":125,"version":"1.2.0","counts_complete":true,
 "semantic_search":"ok","redis":"ok","redis_down_seconds":0, ...}
```

`status` is `degraded` rather than `ok` while a dependency is missing; the body
names which one.

### 5. Check every endpoint — back at the checkout root

```console
~/cs/deploy$ cd ..
~/cs$ bin/test-endpoints
```

Output and what it means are described under **Tests** below.

### Stopping — from `deploy/`

```console
~/cs/deploy$ docker compose down
```

`deploy/volumes/` holds Redis, ChromaDB and log data written by the containers
as root. Removing it needs `sudo`; `docker compose down -v` clears the named
volumes but not that directory.

### If the default ports are taken

`ports.yaml` is the single source of port assignments. Edit it, regenerate
`deploy/.env`, and bring the stack up on the new palette:

```console
~/cs$ sed -i 's/consciousness-server: 13032/consciousness-server: 23032/' ports.yaml
~/cs$ bin/sync-ports
sync-ports: wrote 8 PORT_* lines to /path/to/checkout/deploy/.env

~/cs$ cd deploy && docker compose up -d --build
```

Container-internal ports do not change — only the host-side mapping does.

## Signed requests

An unsigned call to a gated endpoint is refused:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:13032/api/services
401

$ curl -s http://localhost:13032/api/services
{"error":"unauthorized","reason":"missing_headers"}
```

Command-line tools sign through `bin/sign-request` (step 2 above installs what
it needs):

```console
~/cs$ bin/sign-request TUI GET /api/services
X-Agent-Id: TUI
X-Timestamp: 2026-09-01T21:03:29Z
X-Nonce: 1fa0bcaf0d191c6dd8566b029f8f71e5
X-Signature: PzKYvbPPnL8LR3FmvrlgD7HsFmvNOIcaDJou2YvwaGxsdSY+lJJ3LMIjQ4xDGfJoxOTmgWPCW7aE5rdPRTazBQ==
```

`bin/cs-curl` wraps curl with those headers:

```console
$ bin/cs-curl -a TUI GET /api/services

{"services":{"consciousness":{"host":"consciousness-server","port":3032,
"path":"/health","description":"Core — tasks, notes, agents, skills, chat,
memory, embedded WS","status":"active"}, ...},"inactive":{},
"checked_at":"2026-09-01T21:03:29.886Z"}
```

The wire format and the replay window are in
[docs/SIGNING-PROTOCOL.md](docs/SIGNING-PROTOCOL.md); verification modes in
[docs/SIGNED-REQUESTS.md](docs/SIGNED-REQUESTS.md); adding an identity in
[key-server/keys/agents/README.md](key-server/keys/agents/README.md).

## Adding a service

`/api/services` reads `services.yaml` on each request. Append an entry and the
API reports it immediately — no restart, no code change:

```console
$ cat >> services.yaml <<'YAML'

  - name: przyklad-nowa-usluga
    host: nowa
    port: 9999
    path: /health
    description: Dopisana tylko do rejestru
    status: active
YAML

$ bin/cs-curl -a TUI GET /api/services
... "inactive":{"przyklad-nowa-usluga":{"host":"nowa","port":9999,
"description":"Dopisana tylko do rejestru","status":"timeout"}}
```

It lands under `inactive` with `status: timeout` because nothing answers on that
host — the probe ran against the new entry straight away.

## Tests

### Every endpoint, against a running stack

`bin/test-endpoints` asks the core which routes it exposes (`/api/_routes`) and
checks each one: unsigned must be refused, signed must answer. It carries no
route list for the core, so a new core endpoint is covered the moment it exists.
Blocks with their own port publish no route list, so their paths are named in
the script and checked in a second pass.

```console
$ bin/test-endpoints

  METODA  SCIEZKA                              BEZ-PODPISU  Z-PODPISEM   WYNIK
  ------------------------------------------------------------------------------
  GET     /api/agents                          401          200          OK
  GET     /api/agents/:name                    401          404          OK
  POST    /api/agents/register                 401          -            OK
  ...
  GET     /health                              200          200          OK

  test-runner (port 13041)
  GET     /health                              200          -            OK
  GET     /api/test/history                    401          200          OK
  GET     /api/test/00000000-0000-...          401          200          OK
  POST    /api/test/run                        401          -            OK

  git-workflow (port 13042)
  GET     /health                              200          -            OK
  GET     /api/git/history                     401          200          OK
  POST    /api/git/hook/post-commit            401          -            OK

  tras sprawdzonych: 105    OK: 105    do obejrzenia: 0
```

`401` without a signature is the expected result — that column proves the gate
works. `-` means a state-changing method, checked only for refusal. Exit code is
2 if any route fails or if the route list cannot be fetched at all.

The core limits one identity to 60 requests per minute, so the script spreads
its calls across the identities in `deploy/keys/` and retries a `429` under
another one; a route that stays rate-limited is reported, never counted as passed.

### Unit tests

```console
$ (cd core && npm ci && npm test)
# tests 30
# pass 30
# fail 0

$ (cd key-server && npm ci && REDIS_PORT=$(../lib/ports.py redis) npm test)
ok - 17/17 address-allowlist cases
  ok   GET /health → 200
  ...
  ok   enforce: GET /keys/list with valid signature → 200

10 passed, 0 failed

The smoke half needs Redis. `REDIS_PORT` points it at the one the stack
already runs; without it the suite reaches for 6379 and half the checks fail.

$ (cd semantic-search && python3 preview/tests/test_preview.py)
OK: 16, FAIL: 0

$ (cd tui && go test ./...)
ok  	.../tui/cmd/boa-runner	0.007s
ok  	.../tui/internal	0.840s
ok  	.../tui/internal/api	0.014s
ok  	.../tui/internal/layout	0.005s
ok  	.../tui/internal/ports	0.003s
ok  	.../tui/internal/theme	0.002s
ok  	.../tui/internal/tmux	0.002s
```

## Build and run the TUI

`boa` is a terminal panel over the same API the CLI uses. It needs Go 1.26 or
newer and a running stack.

```console
$ (cd tui && go build -o boa ./cmd/boa)
$ (cd tui && ./boa)
```

The panel signs every request, reads included, so it will not start without a
key. With no `--key` it looks for the identity named by `--as` (default `TUI`)
in `deploy/keys/`, which is where step 1 minted it, and then in
`~/.ssh/ecosystem-<NAME>`. Point it somewhere else explicitly when you need to:

```console
$ (cd tui && ./boa --as TUI --key ~/.ssh/ecosystem-TUI)
```

`--core`, `--machines` and `--keys` take base URLs and default to the values in
`ports.yaml`, so a stack on non-default ports needs no flags either. `--version`
prints the build and exits.

The panel drives a full-screen terminal: run it from a real terminal, not from a
pipe or a CI step, or bubbletea exits with `could not open TTY`.

## Optional: document memory

PostgreSQL with pgvector plus `memory-server` are opt-in:

```console
$ docker compose --profile mesh up -d
```

## Configuration

`.env.example` lists every environment variable the core reads, naming the file
and line that reads it. Copy it to `.env` and override only what you need.
To move the whole stack onto different ports, edit `ports.yaml`, run
`bin/sync-ports`, and bring the stack up again.

## Security

[SECURITY.md](SECURITY.md) states the threat model and what this system
deliberately does not protect against: every client that can reach its ports is
trusted, and agents sharing one operating-system account can read each other's
keys.

## License

AGPL-3.0-only — see [LICENSE](LICENSE). A commercial license is available for
use without the AGPL obligations; see [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).
