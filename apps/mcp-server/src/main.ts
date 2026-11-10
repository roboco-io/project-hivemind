import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHivemindMcpServer, loadMcpSettings } from './server.js';

try {
  const server = createHivemindMcpServer(loadMcpSettings());
  server.server.onerror = () => { process.stderr.write('HIVEMIND MCP protocol error.\n'); };
  await server.connect(new StdioServerTransport(process.stdin,process.stdout,{ maxBufferSize: 64000 }));
  const close = () => { void server.close().catch(() => { process.stderr.write('HIVEMIND MCP shutdown error.\n'); }); };
  process.stdin.once('end',close);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,close);
} catch {
  process.stderr.write('Unable to start HIVEMIND MCP server.\n');
  process.exitCode = 1;
}
