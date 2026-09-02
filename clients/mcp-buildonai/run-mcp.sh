#!/bin/bash
cd "$(dirname "$0")" || exit 1
exec npx tsx mcp-server.ts
