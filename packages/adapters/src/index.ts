import { setTimeout as delay } from 'node:timers/promises';
import type { AgentAdapter, Provider } from '../../contracts/src/index.js';
import { createCodexAdapter, type CodexOptions } from './codex.js';
import { createClaudeAdapter } from './claude.js';

const mock: AgentAdapter = {
  provider: 'mock',
  async execute(task, signal) {
    await delay(1000, undefined, { signal });
    return {
      summary: `Mock execution completed for ${task.title}. Synthetic patch only; no repository was changed.`,
      diff: 'diff --git a/hivemind-demo.txt b/hivemind-demo.txt\nnew file mode 100644\n--- /dev/null\n+++ b/hivemind-demo.txt\n@@ -0,0 +1 @@\n+Synthetic demo output from Project HIVEMIND mock worker.\n',
      actualCostMicros: 1000,
    };
  },
};

export function getAdapter(provider: Provider, options?: CodexOptions & {claudeCommand?: string}): AgentAdapter {
  if (provider === 'mock') return mock;
  if (provider === 'codex') {
    if (!options) throw new Error('Codex adapter requires repository and test configuration');
    return createCodexAdapter(options);
  }
  if (provider === 'claude') {
    if (!options) throw new Error('Claude adapter requires repository and test configuration');
    return createClaudeAdapter(options);
  }
  throw new Error(`${provider} adapter is not implemented. Use mock for the local demonstration.`);
}
