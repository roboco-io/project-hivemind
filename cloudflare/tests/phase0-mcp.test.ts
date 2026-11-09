import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio MCP server offers a bounded probe tool and echoes the challenge', { timeout: 10_000 }, async () => {
  const client = new Client({ name: 'phase0-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../scripts/phase0/mcp-server.ts', import.meta.url))],
    env: {}, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['phase0_probe']);
    const nonce = '0123456789abcdef0123456789abcdef';
    const result = await client.callTool({ name: 'phase0_probe', arguments: { nonce } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { nonce, marker: 'hivemind-phase0-mcp-v1' });
    for (const arguments_ of [
      { nonce: 'arbitrary text is not a challenge' },
      { nonce, command: 'unexpected command input' },
    ]) {
      const rejected = await client.callTool({ name: 'phase0_probe', arguments: arguments_ });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent, undefined);
    }
  } finally {
    await client.close();
  }
});
