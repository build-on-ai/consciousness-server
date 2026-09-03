// Ports come from ports.yaml, the same file lib/ports.{js,py} and the TUI read.
//
// This client runs on the host, not in the compose network, so it must use the
// published ports (13032, 13037), not the container-internal ones. Writing
// 3032 here meant a fresh deployment answered on 13032 while the client knocked
// on a port nothing had opened.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function findPortsFile(): string | null {
  if (process.env.CS_PORTS_FILE) return process.env.CS_PORTS_FILE;
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "ports.yaml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Same plain-line reading as lib/ports.js: the format is fixed and a YAML
// library would be one more thing to install before the client can start.
function loadPorts(): Record<string, number> {
  const file = findPortsFile();
  if (!file) return {};
  const out: Record<string, number> = {};
  let inPorts = false;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^[A-Za-z][\w-]*:\s*$/.test(line)) {
      inPorts = line.trim().replace(/:$/, "") === "ports";
      continue;
    }
    if (!inPorts) continue;
    const m = line.match(/^\s+([A-Za-z][\w-]*):\s+(\d+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const ports = loadPorts();

export function urlFor(service: string, envVar: string, fallback: number): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = ports[service] ?? fallback;
  return `http://127.0.0.1:${port}`;
}
