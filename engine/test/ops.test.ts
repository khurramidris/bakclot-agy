// The ops dashboard's arithmetic and rules (no database): latency percentiles, runway, retention, chart buckets, route
// labels and the "needs you" list. Run: npm test
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, pathLabel, LATENCY_BOUNDS } from '../src/telemetry.js';
import { percentileMs, runwayDays, projectMonth, cohortMatrix, needsYou, stepFor, clampDays, clampHours, type Facts } from '../src/ops/stats.js';

test('latency buckets: each bound is inclusive, anything slower goes in the last bucket', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(25), 0);
  assert.equal(bucketOf(25.1), 1);
  assert.equal(bucketOf(10_000), LATENCY_BOUNDS.length - 1);
  assert.equal(bucketOf(60_000), LATENCY_BOUNDS.length);
});

test('requests no route matched are counted under a fixed label, never their raw path', () => {
  assert.equal(pathLabel('/assets/index-abc123.js'), '/assets/*');
  assert.equal(pathLabel('/files/projects/1/clip.mp4'), '/files/*');
  assert.equal(pathLabel('/v1/wp-admin/../etc'), '(no such route)');
  assert.equal(pathLabel('/webhooks/stripe'), '(no such route)');
  assert.equal(pathLabel('/dashboard'), '(web page)');
  assert.equal(pathLabel('/p/0b5c2f0e-1111-4222-8333-444455556666'), '(web page)');
});

test('percentiles from a histogram: interpolated inside the bucket, never above the slowest request', () => {
  const h = new Array(LATENCY_BOUNDS.length + 1).fill(0);
  assert.equal(percentileMs(h, 0.95, 0), null);
  h[0] = 10; // ten requests of at most 25 ms, the slowest 20 ms
  assert.equal(percentileMs(h, 0.5, 20), 12.5);
  assert.equal(percentileMs(h, 0.95, 20), 20);
  const slow = new Array(LATENCY_BOUNDS.length + 1).fill(0);
  slow[LATENCY_BOUNDS.length] = 4; // all slower than 10 s, the slowest 15 s
  assert.equal(percentileMs(slow, 0.5, 15_000), 12_500);
  const mixed = new Array(LATENCY_BOUNDS.length + 1).fill(0);
  mixed[2] = 90; mixed[6] = 10; // 90 at 50–100 ms, 10 at 1–2.5 s
  assert.ok(percentileMs(mixed, 0.5, 2000)! > 50 && percentileMs(mixed, 0.5, 2000)! <= 100);
  assert.ok(percentileMs(mixed, 0.99, 2000)! > 1000);
  assert.equal(percentileMs(null, 0.5, 10), null);
});

test('runway and month-end projection', () => {
  assert.equal(runwayDays(100, 10), 10);
  assert.equal(runwayDays(100, 0), null);
  assert.equal(runwayDays(-5, 10), 0);
  assert.equal(projectMonth(100, 10, new Date('2026-11-20T00:00:00Z')), 210); // 11 days left in November
});

test('weekly retention: share of each sign-up week active in the weeks since, only weeks that have happened', () => {
  const m = cohortMatrix(
    [{ cohort: '2026-11-09', week: 0, active: 2 }, { cohort: '2026-11-09', week: 1, active: 1 }],
    { '2026-11-09': 2, '2026-11-16': 1 }, new Date('2026-11-20T12:00:00Z'));
  assert.deepEqual(m, [{ cohort: '2026-11-09', size: 2, weeks: [100, 50] }, { cohort: '2026-11-16', size: 1, weeks: [0] }]);
});

test('chart buckets and ranges', () => {
  assert.equal(stepFor(1), 60);
  assert.equal(stepFor(24), 900);
  assert.equal(stepFor(168), 3600);
  assert.equal(stepFor(720), 21600);
  assert.equal(clampHours('168'), 168);
  assert.equal(clampHours('5'), 24);
  assert.equal(clampDays('abc'), 30);
  assert.equal(clampDays(1000), 365);
  assert.equal(clampDays(0), 30);
});

const calm: Facts = {
  engine: { ok: true }, heartbeatMinutes: 0.5, oldestRenderMinutes: 2, rendersWaiting: 1, oldestJobMinutes: 0, jobsFailed24h: 0,
  filmsFailed24h: 0, api: { requests: 500, errors: 0 }, webhookFailures24h: 0, webhookBadSignatures24h: 0, webhookOk24h: 3, pastDue: 0,
  gpuError: null, budgets: [], runpodRunwayDays: null, costlyCustomers: 0, waitingForApproval: 0, refusals24h: { checks: 10, refused: 1 },
  profitMonth: 50, revenueMonth: 200,
};

test('needs you: nothing when all is well', () => {
  assert.deepEqual(needsYou(calm), []);
});

test('needs you: the worst first, each pointing at the page that explains it', () => {
  const n = needsYou({ ...calm, engine: { ok: false, error: 'unreachable' }, waitingForApproval: 2, pastDue: 1, oldestRenderMinutes: 45, rendersWaiting: 6 });
  assert.deepEqual(n.map((x) => x.level), ['bad', 'bad', 'warn', 'info']);
  assert.equal(n[0]!.title, 'The app isn’t answering');
  assert.match(n[0]!.detail, /unreachable/);
  assert.equal(n[1]!.page, 'live');
  assert.equal(n[2]!.title, '1 customer’s payment is failing');
  assert.equal(n[3]!.title, '2 films waiting for approval');
});

test('needs you: server errors, webhooks, budgets, the worker and content checks', () => {
  const titles = (f: Partial<Facts>) => needsYou({ ...calm, ...f }).map((x) => `${x.level}: ${x.title}`);
  assert.deepEqual(titles({ api: { requests: 100, errors: 5 } }), ['bad: The app is returning errors']);
  assert.deepEqual(titles({ api: { requests: 10, errors: 1 } }), ['warn: Some server errors']);
  assert.deepEqual(titles({ webhookFailures24h: 2 }), ['bad: Payment webhooks are failing']);
  assert.deepEqual(titles({ webhookBadSignatures24h: 3, webhookOk24h: 2 }), [], 'forged deliveries while real ones get through: noise');
  assert.deepEqual(titles({ webhookBadSignatures24h: 3, webhookOk24h: 0 }), ['warn: Webhooks with a wrong signature']);
  assert.deepEqual(titles({ budgets: [{ provider: 'MiniMax', runwayDays: 1.5, left: 3 }] }), ['bad: MiniMax budget runs out soon']);
  assert.deepEqual(titles({ budgets: [{ provider: 'MiniMax', runwayDays: 0, left: 0 }] }), ['bad: MiniMax budget used up']);
  assert.deepEqual(titles({ heartbeatMinutes: 12 }), ['bad: The job worker has stopped']);
  assert.deepEqual(titles({ heartbeatMinutes: null }), ['warn: No heartbeat from the job worker yet']);
  assert.deepEqual(titles({ refusals24h: { checks: 10, refused: 5 } }), ['warn: Many content refusals']);
  assert.deepEqual(titles({ profitMonth: -20 }), ['warn: Losing money this month']);
  assert.deepEqual(titles({ profitMonth: -20, revenueMonth: 0 }), [], 'no revenue yet is not "losing money"');
});
