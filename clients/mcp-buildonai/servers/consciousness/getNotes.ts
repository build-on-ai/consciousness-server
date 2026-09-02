
const CS_URL = "http://127.0.0.1:3032";

interface Note {
  id: string;
  agent: string;
  type: string;
  title: string;
  content: string;
  created_at?: string;
}

interface NotesResponse {
  total: number;
  notes: Note[];
}

export async function getNotes(agent?: string): Promise<Note[]> {
  const url = agent
    ? `${CS_URL}/api/notes?agent=${agent}`
    : `${CS_URL}/api/notes`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch notes: ${response.status}`);
  }
  const data: NotesResponse = await response.json();
  return data.notes;
}

export async function getNotesSummary(agent?: string, limit: number = 5): Promise<string> {
  const notes = await getNotes(agent);
  if (notes.length === 0) {
    return agent ? `No notes for ${agent}` : "No notes found";
  }
  const summary = notes.slice(0, limit).map(n =>
    `- [${n.agent}] ${n.title}: ${n.content.substring(0, 80)}...`
  ).join('\n');
  return `Notes (${notes.length} total):\n${summary}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agent = process.argv[2];
  getNotesSummary(agent)
    .then(console.log)
    .catch(console.error);
}
