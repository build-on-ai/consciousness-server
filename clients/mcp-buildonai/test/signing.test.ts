// Klucz powstaje tak jak w bin/bootstrap-keys (ssh-keygen, format OpenSSH), a podpis
// sprawdza klucz publiczny z pliku .pub, bez udziału kodu, który podpisuje.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-signing-"));
const keyPath = path.join(dir, "TEST");
execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "TEST", "-f", keyPath, "-q"]);
process.env.CS_SIGNING_KEY = keyPath;
process.env.CS_AGENT_ID = "TEST";

const { signHeaders, assertUsable } = await import("../signing.js");

// Blob OpenSSH dla ed25519 kończy się surowym 32-bajtowym kluczem publicznym.
function publicKeyFromOpenSsh(file: string): crypto.KeyObject {
  const blob = Buffer.from(fs.readFileSync(file, "utf8").split(" ")[1], "base64");
  const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([spkiHeader, blob.subarray(blob.length - 32)]),
    format: "der",
    type: "spki",
  });
}

function canonical(h: Record<string, string>, method: string, p: string, body: string) {
  const sha = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return Buffer.from([method, p, h["X-Timestamp"], h["X-Nonce"], sha].join("\n"), "utf8");
}

test("klucz ed25519 z ssh-keygen daje się wczytać", () => {
  assert.doesNotThrow(() => assertUsable());
});

test("podpis żądania weryfikuje się kluczem publicznym z pliku .pub", () => {
  const body = JSON.stringify({ from: "TEST", content: "@ALL ping" });
  const h = signHeaders("post", "/api/chat?x=1", body);
  const pub = publicKeyFromOpenSsh(`${keyPath}.pub`);

  assert.equal(h["X-Agent-Id"], process.env.CS_AGENT_ID);
  assert.match(h["X-Timestamp"], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(h["X-Nonce"], /^[0-9a-f]{32}$/);
  const sig = Buffer.from(h["X-Signature"], "base64");
  assert.ok(crypto.verify(null, canonical(h, "POST", "/api/chat", body), pub, sig));
  assert.ok(!crypto.verify(null, canonical(h, "POST", "/api/chat", body + " "), pub, sig));
});

test("klucz bez CS_AGENT_ID nie startuje i nie podpisuje", () => {
  delete process.env.CS_AGENT_ID;
  try {
    assert.throws(() => assertUsable(), /CS_AGENT_ID jest pusty/);
    assert.throws(() => signHeaders("GET", "/api/agents"), /CS_AGENT_ID jest pusty/);
  } finally {
    process.env.CS_AGENT_ID = "TEST";
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
