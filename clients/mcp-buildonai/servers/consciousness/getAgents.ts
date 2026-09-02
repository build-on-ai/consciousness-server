
const CS_URL = "http://127.0.0.1:3032";

interface Agent {
  name: string;
  status: string;
  location?: string;
  role?: string;
  last_heartbeat?: string;
}

interface AgentsResponse {
  total: number;
  agents: Agent[];
}

export async function getAgents(): Promise<Agent[]> {
  const response = await fetch(`${CS_URL}/api/agents`);
  if (!response.ok) {
    throw new Error(`Failed to fetch agents: ${response.status}`);
  }
  const data: AgentsResponse = await response.json();
  return data.agents;
}

export async function getAgentsSummary(): Promise<string> {
  const agents = await getAgents();
  const active = agents.filter(a => a.status === 'BUSY' || a.status === 'FREE').length;
  const statuses = agents.map(a => `${a.name}:${a.status}`).join(', ');
  return `Agents: ${agents.length} total, ${active} active. [${statuses}]`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  getAgentsSummary()
    .then(console.log)
    .catch(console.error);
}
