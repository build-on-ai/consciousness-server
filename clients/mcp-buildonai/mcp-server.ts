
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { signHeaders, assertUsable, isConfigured, agentId } from "./signing.js";

const CS_URL = process.env.CONSCIOUSNESS_URL || "";
const SEARCH_URL = process.env.SEARCH_URL || "";
const SKILLS_URL = process.env.SKILLS_URL || "";

if (!CS_URL) {
  console.error(
    "CONSCIOUSNESS_URL nie jest ustawione. Podaj adres rdzenia, np.\n" +
    "  CONSCIOUSNESS_URL=http://127.0.0.1:$(lib/ports.py consciousness-server)"
  );
  process.exit(2);
}


async function fetchJSON(url: string, options?: RequestInit) {
  const method = (options?.method || "GET").toUpperCase();
  const body = typeof options?.body === "string" ? options.body : undefined;
  const { pathname } = new URL(url);

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options?.headers as Record<string, string> | undefined),
      ...signHeaders(method, pathname, body),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error(
        `HTTP 401: ${url} — żądanie odrzucone jako niepodpisane lub podpisane nieznanym kluczem. ` +
        `Tożsamość: ${agentId()}. Sprawdź CS_SIGNING_KEY i czy key-server ma keys/agents/${agentId()}.pub`
      );
    }
    throw new Error(`HTTP ${response.status}: ${url}${body ? ` — ${body.substring(0, 200)}` : ""}`);
  }
  return response.json();
}


async function getAgentsSummary(): Promise<string> {
  const data = await fetchJSON(`${CS_URL}/api/agents`);
  const agents = data.agents || [];
  if (agents.length === 0) return "Brak agentów";
  const statuses = agents.map((a: any) => `${a.name}:${a.status}`).join(", ");
  return `Agenci (${agents.length}): ${statuses}`;
}

async function getNotesSummary(agent?: string, limit = 5): Promise<string> {
  const url = agent ? `${CS_URL}/api/notes?agent=${agent}` : `${CS_URL}/api/notes`;
  const data = await fetchJSON(url);
  const notes = data.notes || data || [];
  if (notes.length === 0) return agent ? `Brak notatek dla ${agent}` : "Brak notatek";
  const summary = notes.slice(0, limit).map((n: any) =>
    `- [${n.agent}] ${n.title}: ${(n.content || "").substring(0, 60)}...`
  ).join("\n");
  return `Notatki (${notes.length}):\n${summary}`;
}

async function sendChat(_from: string, to: string, content: string): Promise<string> {
  const from = agentId();
  const mention = `@${to}`;
  const body = content.includes(mention) ? content : `${mention} ${content}`;
  const data = await fetchJSON(`${CS_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, content: body })
  });
  const reached = data.mentions?.length ? data.mentions.join(", ") : "nikogo (brak wzmianek)";
  return `✓ Wysłano jako ${from}, powiadomieni: ${reached} — "${body.substring(0, 50)}..."`;
}

async function searchMemory(query: string, limit = 5): Promise<string> {
  const data = await fetchJSON(`${SEARCH_URL}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit })
  });
  const results = data.results || [];
  if (results.length === 0) return `Brak wyników dla: "${query}"`;
  const summary = results.map((r: any, i: number) =>
    `${i + 1}. [${r.collection}] ${(r.text || "").substring(0, 100)}...`
  ).join("\n");
  return `Wyniki dla "${query}" (${results.length}):\n${summary}`;
}

async function saveNote(agent: string, title: string, content: string, type = "observation"): Promise<string> {
  await fetchJSON(`${CS_URL}/api/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, type, title, content })
  });
  return `✓ Zapisano notatkę: "${title}"`;
}

async function getServicesSummary(): Promise<string> {
  const data = await fetchJSON(`${CS_URL}/api/services`);
  const services = data.services || [];
  const summary = services.map((s: any) => 
    `${s.name}:${s.port}:${s.status || "?"}`
  ).join(", ");
  return `Serwisy (${services.length}): ${summary}`;
}

async function getSkillsList(): Promise<string> {
  const data = await fetchJSON(`${SKILLS_URL}/skills/list`);
  const skills = data.skills || [];
  const names = skills.map((s: any) => s.name).join(", ");
  return `Skills (${skills.length}): ${names}`;
}


async function getTasks(agent?: string, limit = 10): Promise<string> {
  const url = agent ? `${CS_URL}/api/tasks/pending/${encodeURIComponent(agent)}` : `${CS_URL}/api/tasks`;
  const data = await fetchJSON(url);
  const tasks = Array.isArray(data) ? data : data.tasks || [];
  if (tasks.length === 0) return agent ? `Brak zadań oczekujących dla ${agent}` : "Brak zadań";
  const summary = tasks.slice(0, limit).map((t: any) =>
    `- [${t.status || "?"}] ${t.title} → ${t.assigned_to || "nieprzypisane"}${t.priority ? ` (${t.priority})` : ""}`
  ).join("\n");
  return `Zadania (${tasks.length}):\n${summary}`;
}

async function createTask(
  project: string, title: string, created_by: string,
  assigned_to?: string, priority = "MEDIUM"
): Promise<string> {
  const payload: Record<string, string> = { project, title, created_by, priority };
  if (assigned_to) payload.assigned_to = assigned_to;
  const data = await fetchJSON(`${CS_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const target = assigned_to ? `dla @${assigned_to}` : "do puli (do wzięcia przez claim)";
  return `✓ Zadanie utworzone ${target}: "${title}"${data.id ? ` (id ${data.id})` : ""}`;
}

async function getChatHistory(limit = 20): Promise<string> {
  const data = await fetchJSON(`${CS_URL}/api/chat?limit=${limit}`);
  const messages = data.messages || data || [];
  if (messages.length === 0) return "Brak wiadomości";
  const summary = messages.slice(-limit).map((m: any) =>
    `[${m.from}→${m.to || "@all"}] ${(m.content || "").substring(0, 80)}`
  ).join("\n");
  return `Czat (${messages.length}):\n${summary}`;
}

async function getSummaries(agent: string | undefined, limit = 5): Promise<string> {
  if (!agent) {
    return "Podaj agenta — rdzeń nie ma domyślnej tożsamości dla podsumowań.";
  }
  const data = await fetchJSON(
    `${CS_URL}/api/memory/summaries?agent=${encodeURIComponent(agent)}&limit=${limit}`
  );
  const items = data.summaries || data || [];
  if (items.length === 0) return `Brak podsumowań sesji dla ${agent}`;
  const summary = items.slice(0, limit).map((s: any) =>
    `- ${s.created_at || s.date || "?"}: ${(s.summary || s.content || "").substring(0, 100)}...`
  ).join("\n");
  return `Podsumowania sesji ${agent} (${items.length}):\n${summary}`;
}

async function getIdentity(role: string): Promise<string> {
  const wanted = role.toUpperCase();
  const list = await fetchJSON(`${CS_URL}/api/identity/claude-md`);
  const available: string[] = list.agents || [];
  if (!available.includes(wanted)) {
    return `Brak karty roli "${wanted}". Dostępne (${available.length}): ${available.join(", ")}`;
  }
  const data = await fetchJSON(`${CS_URL}/api/identity/claude-md/${encodeURIComponent(wanted)}`);
  const content = data.claude_md || data.content || "";
  if (!content) return `Karta roli ${wanted} jest pusta`;
  return `Karta roli ${wanted} (${content.length} znaków):\n${content.substring(0, 600)}${content.length > 600 ? "\n…" : ""}`;
}


const server = new Server(
  { name: "buildonai-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "agents",
      description: "Lista agentów i ich statusów (skrócona)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "notes",
      description: "Pobierz notatki (skrócone)",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Filtruj po agencie (opcjonalne)" },
          limit: { type: "number", description: "Limit wyników (domyślnie 5)" }
        }
      }
    },
    {
      name: "chat",
      description: "Wyślij wiadomość do agenta albo broadcast do wszystkich",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "IGNOROWANE — autorem jest tożsamość, którą ten klient podpisuje (CS_AGENT_ID). Żeby pisać jako inna rola, użyj bin/say --as ROLA" },
          to: { type: "string", description: "Do kogo; \"all\" wysyła do wszystkich. Trafia do treści jako @wzmianka, bo tylko po niej rdzeń rozpoznaje adresata" },
          content: { type: "string", description: "Treść wiadomości" }
        },
        required: ["from", "to", "content"]
      }
    },
    {
      name: "search",
      description: "Semantic search w pamięci (skrócony)",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Zapytanie" },
          limit: { type: "number", description: "Limit wyników (domyślnie 5)" }
        },
        required: ["query"]
      }
    },
    {
      name: "remember",
      description: "Zapisz notatkę do pamięci",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent zapisujący" },
          title: { type: "string", description: "Tytuł notatki" },
          content: { type: "string", description: "Treść notatki" },
          type: { type: "string", enum: ["observation", "decision", "blocker", "idea", "handoff", "session_end"], description: "Typ notatki (domyślnie observation)" }
        },
        required: ["agent", "title", "content"]
      }
    },
    {
      name: "services",
      description: "Status serwisów (skrócony)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "skills",
      description: "Lista dostępnych skilli",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "tasks",
      description: "Zadania: wszystkie albo oczekujące dla wskazanego agenta",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Tylko zadania oczekujące tego agenta (opcjonalne)" },
          limit: { type: "number", description: "Limit wyników (domyślnie 10)" }
        }
      }
    },
    {
      name: "tasks_create",
      description: "Utwórz zadanie i przypisz je agentowi",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Projekt" },
          title: { type: "string", description: "Tytuł zadania" },
          created_by: { type: "string", description: "Agent zlecający" },
          assigned_to: { type: "string", description: "Agent wykonujący; POMIŃ, żeby zadanie trafiło do puli i ktokolwiek wziął je przez claim" },
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"], description: "Priorytet (domyślnie MEDIUM)" }
        },
        required: ["project", "title", "created_by"]
      }
    },
    {
      name: "chat_history",
      description: "Ostatnie wiadomości z czatu agentów",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Ile wiadomości (domyślnie 20)" }
        }
      }
    },
    {
      name: "summaries",
      description: "Podsumowania ostatnich sesji agenta",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent, którego podsumowania pobrać" },
          limit: { type: "number", description: "Limit wyników (domyślnie 5)" }
        }
      }
    },
    {
      name: "identity",
      description: "Karta roli z rdzenia. Indeks po NAZWIE ROLI (OBSERVER_EXAMPLE, BUILDER_EXAMPLE), nie po skrócie agenta — bez argumentu zwraca listę dostępnych",
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string", description: "Nazwa roli, np. OBSERVER_EXAMPLE (wielkość liter bez znaczenia)" }
        },
        required: ["role"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    let result: string;
    
    switch (name) {
      case "agents":
        result = await getAgentsSummary();
        break;
      case "notes":
        result = await getNotesSummary(args?.agent as string, args?.limit as number);
        break;
      case "chat":
        result = await sendChat(args!.from as string, args!.to as string, args!.content as string);
        break;
      case "search":
        result = await searchMemory(args!.query as string, args?.limit as number);
        break;
      case "remember":
        result = await saveNote(args!.agent as string, args!.title as string, args!.content as string, args?.type as string | undefined);
        break;
      case "services":
        result = await getServicesSummary();
        break;
      case "skills":
        result = await getSkillsList();
        break;
      case "tasks":
        result = await getTasks(args?.agent as string | undefined, args?.limit as number);
        break;
      case "tasks_create":
        result = await createTask(
          args!.project as string, args!.title as string, args!.created_by as string,
          args?.assigned_to as string | undefined, args?.priority as string | undefined
        );
        break;
      case "chat_history":
        result = await getChatHistory(args?.limit as number);
        break;
      case "summaries":
        result = await getSummaries(args?.agent as string | undefined, args?.limit as number);
        break;
      case "identity":
        result = await getIdentity(args!.role as string);
        break;
      default:
        throw new Error(`Nieznane narzędzie: ${name}`);
    }
    
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Błąd: ${error}` }], isError: true };
  }
});

async function main() {
  assertUsable();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    isConfigured()
      ? `BuildOnAI MCP Server started — podpisuje jako ${agentId()}`
      : "BuildOnAI MCP Server started — BEZ PODPISU (CS_SIGNING_KEY nieustawiony); " +
        "bez klucza każde wywołanie dostanie 401"
  );
}

main().catch(console.error);
