import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = process.cwd();
const entryPath = resolve(root, '.claude/skills/hivemind/SKILL.md');
const canonicalPath = resolve(root, '.agents/skills/hivemind/SKILL.md');

function links(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]!);
}

test('Claude project skill resolves the shared workflow from its own directory', async () => {
  const entry = await readFile(entryPath, 'utf8');
  assert.match(entry, /^---\nname: hivemind\ndescription: .+\n---/);
  const destinations = links(entry).map(link => resolve(dirname(entryPath), link));
  assert.ok(destinations.includes(canonicalPath), 'Claude must load the existing canonical workflow');
  for (const destination of destinations) await readFile(destination, 'utf8');
});

test('Claude routing requires a fresh canonical read before tool calls and stops on read failure', async () => {
  const entry = await readFile(entryPath, 'utf8');
  assert.match(entry, /호출할 때마다[\s\S]*도구 호출 전에[\s\S]*읽/);
  assert.match(entry, /읽을 수 없으면[\s\S]*중단/);
  assert.doesNotMatch(entry, /hivemind_(?:status|create_task|decide_task|cancel_task|get_result|list_tasks)/);
  assert.doesNotMatch(entry, /(?:^|\n)(?:allowed-tools|hooks|permission-mode|permissions):/);
  assert.doesNotMatch(entry, /bypassPermissions|dangerously-skip-permissions|mcp__hivemind__\*/);
});

test('shared workflow and its supporting references remain accessible to Claude', async () => {
  const canonical = await readFile(canonicalPath, 'utf8');
  for (const link of links(canonical).filter(link => !/^https?:/.test(link))) {
    await readFile(resolve(dirname(canonicalPath), link), 'utf8');
  }
  for (const boundary of ['baseCommit', 'awaiting_execution_approval', 'awaiting_review', 'CANCELLING', 'CONFIGURATION_CHANGED']) {
    assert.ok(canonical.includes(boundary), `shared workflow must retain ${boundary} boundary`);
  }
});
