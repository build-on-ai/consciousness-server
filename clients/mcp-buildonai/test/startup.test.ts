// Proces klienta z zamkniętym stdin: poprawny start kończy się kodem 0, odmowa kodem różnym od 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-"));
const keyPath = path.join(dir, "TEST");
execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "TEST", "-f", keyPath, "-q"]);

function start(agentId?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONSCIOUSNESS_URL: "http://127.0.0.1:9",
    CS_SIGNING_KEY: keyPath,
  };
  delete env.CS_AGENT_ID;
  if (agentId !== undefined) env.CS_AGENT_ID = agentId;
  return spawnSync(process.execPath, ["--import", "tsx", "mcp-server.ts"], {
    cwd: clientDir,
    env,
    input: "",
    encoding: "utf8",
    timeout: 20000,
  });
}

test("klucz i CS_AGENT_ID: klient startuje i kończy się kodem 0", () => {
  const r = start("TEST");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /podpisuje jako TEST/);
});

test("klucz bez CS_AGENT_ID: klient odmawia z kodem różnym od 0", () => {
  const r = start();
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /CS_AGENT_ID jest pusty/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
