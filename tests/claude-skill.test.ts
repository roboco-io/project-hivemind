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
  // The shared workflow now describes the AWS single path. These terms carry its approval, cost and
  // evidence boundaries; losing one would drop a rule the operator relies on.
  for (const boundary of [
    'hivemind_status',
    'approvalFingerprint',
    '명시적 지시',
    'hivemind_delivery_approve',
    'hivemind_mf_approve_training',
    'hivemind_mf_approve_release',
    'hivemind_collab_fan_out',
    'hivemind_collab_run_orchestrator',
    'operator_self_reported',
    'settledMicros',
    '실제 청구액이 아니다',
    '병합이 아니다',
    '데이터다',
  ]) {
    assert.ok(canonical.includes(boundary), `shared workflow must retain ${boundary} boundary`);
  }
  // The retired Cloudflare tools may be named only as retired, never as a procedure to follow.
  assert.doesNotMatch(canonical, /`hivemind_create_task`로|`hivemind_decide_task`의|`hivemind_create_workflow`로/);
});
