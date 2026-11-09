import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'hivemind-phase0', version: '0.1.0' });
server.registerTool('phase0_probe', {
  description: 'Echo a generated 128-bit hexadecimal challenge for the feasibility test. No files or network access.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: z.strictObject({ nonce: z.string().regex(/^[0-9a-f]{32}$/) }),
  outputSchema: { nonce: z.string(), marker: z.literal('hivemind-phase0-mcp-v1') },
}, async ({ nonce }) => {
  const output = { nonce, marker: 'hivemind-phase0-mcp-v1' };
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
});
await server.connect(new StdioServerTransport());
