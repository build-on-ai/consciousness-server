
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SigningHeaders = Record<string, string>;

let cachedKey: crypto.KeyObject | null | undefined;
let cachedKeyPath: string | undefined;

function loadSigningKey(): crypto.KeyObject | null {
  const keyPath = (process.env.CS_SIGNING_KEY || "").trim();
  if (!keyPath) return null;

  if (cachedKey !== undefined && cachedKeyPath === keyPath) return cachedKey;
  cachedKeyPath = keyPath;

  try {
    const sshpk = require("sshpk");
    const parsed = sshpk.parsePrivateKey(fs.readFileSync(keyPath), "auto");
    if (parsed.type !== "ed25519") {
      throw new Error(`klucz jest typu ${parsed.type}; przyjmujemy wyłącznie ed25519`);
    }
    cachedKey = crypto.createPrivateKey(parsed.toString("pkcs8"));
  } catch (err) {
    cachedKey = undefined;
    throw new Error(
      `[signing] CS_SIGNING_KEY=${keyPath} nie da się użyć: ${(err as Error).message}`
    );
  }
  return cachedKey;
}

export function assertUsable(): void {
  loadSigningKey();
}

export function isConfigured(): boolean {
  return Boolean((process.env.CS_SIGNING_KEY || "").trim());
}

export function agentId(): string {
  return (process.env.CS_AGENT_ID || "").trim();
}

export function signHeaders(
  method: string,
  path: string,
  body?: string | Buffer
): SigningHeaders {
  const key = loadSigningKey();
  if (!key) return {};

  const timestamp = new Date().toISOString().split(".")[0] + "Z";
  const nonce = crypto.randomBytes(16).toString("hex");
  const cleanPath = String(path || "/").split("?")[0];
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "", "utf8");
  const bodySha256 = crypto.createHash("sha256").update(bodyBytes).digest("hex");

  const canonical = [
    String(method || "").toUpperCase(),
    cleanPath,
    timestamp,
    nonce,
    bodySha256,
  ].join("\n");

  const signature = crypto
    .sign(null, Buffer.from(canonical, "utf8"), key)
    .toString("base64");

  return {
    "X-Agent-Id": agentId(),
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
  };
}
