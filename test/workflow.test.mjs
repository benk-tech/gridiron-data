// The scheduled workflow must never be gated on the offline tests: a failing (or date dependent) test would skip the
// collect step and every step after it, so the site would go stale. The tests run in their own workflow instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WF = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const read = (f) => readFileSync(join(WF, f), 'utf8');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // drop comment lines

test('collect.yml runs no tests before the collect step; test.yml runs them on push and pull request', () => {
  const collect = code(read('collect.yml'));
  assert.doesNotMatch(collect, /node\s+--test/);
  assert.match(collect, /node collect\.mjs --post --settle/);
  // the collect step keeps the default if: and nothing before it can fail on test results
  const steps = collect.split(/\n\s*- (?:id|name|uses):/);
  const iCollect = steps.findIndex((s) => /node collect\.mjs/.test(s));
  assert.ok(iCollect > 0);
  for (const s of steps.slice(0, iCollect)) assert.doesNotMatch(s, /--test|npm test/);

  const t = code(read('test.yml'));
  assert.match(t, /node --test test\/\*\.test\.mjs/);
  assert.match(t, /\bpush:/);
  assert.match(t, /\bpull_request:/);
  assert.doesNotMatch(t, /\bschedule:/);
  assert.doesNotMatch(t, /secrets\./, 'the test workflow needs no secrets');
});

test('collect.yml: the collect step has its own timeout inside the 4 minute job, and the state steps still run', () => {
  const collect = code(read('collect.yml'));
  const job = Number(/timeout-minutes:\s*(\d+)/.exec(collect)?.[1]);
  assert.equal(job, 4, 'SPEC 10.2: timeout 4 min');
  const step = /name: Collect, post, settle\n\s+timeout-minutes:\s*(\d+)/.exec(collect);
  assert.ok(step, 'collect step timeout');
  assert.ok(Number(step[1]) < job, 'the step backstop leaves time for the always() steps');
  for (const name of ['Commit closes archive', 'Save state', 'Daily cache key']) {
    assert.match(collect, new RegExp(`name: ${name}\\n\\s+if: \\$\\{\\{ always\\(\\) && steps\\.collect\\.outcome != 'skipped' \\}\\}`), name);
  }
});
