import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SigningHeaders = Record<string, string>;

// Podpis składa lib/sign-outbound.js; middleware/ trzyma jego kopię z bin/sync-middleware.
const shared: {
  signHeaders(agentId: string, method: string, path: string, body?: string | Buffer): SigningHeaders;
  assertUsable(): void;
} = require("./middleware/sign-outbound.js");

// Bez jawnej tożsamości wspólny moduł podpisałby jako cs-core, czyli jako rdzeń.
function signingAgentId(): string {
  const id = agentId();
  if (isConfigured() && !id) {
    throw new Error("[signing] CS_SIGNING_KEY jest ustawiony, ale CS_AGENT_ID jest pusty; podaj tożsamość, którą podpisuje ten klucz");
  }
  return id;
}

export function assertUsable(): void {
  signingAgentId();
  shared.assertUsable();
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
  return shared.signHeaders(signingAgentId(), method, path, body);
}
