
const SEARCH_URL = "http://127.0.0.1:3037";

interface SearchResult {
  id: string;
  text: string;
  collection: string;
  distance: number;
  metadata?: Record<string, unknown>;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export async function search(query: string, limit: number = 5): Promise<SearchResponse> {
  const response = await fetch(`${SEARCH_URL}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit })
  });
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  return response.json();
}

export async function searchSummary(query: string, limit: number = 5): Promise<string> {
  const data = await search(query, limit);
  if (!data.results || data.results.length === 0) {
    return `No results for: "${query}"`;
  }
  const results = data.results.map((r, i) =>
    `${i + 1}. [${r.collection}] ${r.text.substring(0, 120)}...`
  ).join('\n');
  return `Search "${query}" (${data.results.length} results):\n${results}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const query = process.argv.slice(2).join(' ');
  if (!query) {
    console.log('Usage: search.ts QUERY');
    process.exit(1);
  }
  searchSummary(query)
    .then(console.log)
    .catch(console.error);
}
