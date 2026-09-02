
const CS_URL = "http://127.0.0.1:3032";

interface ChatResponse {
  message_id: string;
  timestamp: string;
  mentions: string[];
}

export async function sendChat(from: string, to: string, content: string): Promise<ChatResponse> {
  const response = await fetch(`${CS_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, content })
  });
  if (!response.ok) {
    throw new Error(`Failed to send chat: ${response.status}`);
  }
  return response.json();
}

export async function sendChatSummary(from: string, to: string, content: string): Promise<string> {
  const result = await sendChat(from, to, content);
  return `✓ Sent to @${to} [${result.message_id.substring(0, 8)}]: "${content.substring(0, 50)}..."`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [from, to, ...contentParts] = process.argv.slice(2);
  const content = contentParts.join(' ');
  if (!from || !to || !content) {
    console.log('Usage: sendChat.ts FROM TO CONTENT');
    process.exit(1);
  }
  sendChatSummary(from, to, content)
    .then(console.log)
    .catch(console.error);
}
