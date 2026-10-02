import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBoard } from '../src/providers.js';

const gh = (overrides = {}) => ({
  id: 123, title: 'Junior Financial Analyst', location: { name: 'Boston, MA' },
  absolute_url: 'https://boards.greenhouse.io/acme/jobs/123',
  content: '<p>Build &amp; review models.</p>', updated_at: '2026-09-01T00:00:00Z',
  ...overrides,
});
const lever = (overrides = {}) => ({
  id: 'abc-123', text: 'FP&A Analyst', categories: { location: 'Remote - US' },
  hostedUrl: 'https://jobs.lever.co/acme/abc-123',
  description: '<p>Financial planning</p>',
  lists: [{ text: 'Requirements', content: '<ul><li>Excel</li><li>Modeling</li></ul>' }],
  additional: '<p>Apply today</p>', createdAt: 1_700_000_000_000,
  ...overrides,
});
const json = (value, options = {}) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json; charset=utf-8' }, ...options,
});
const board = (provider, fetchImpl, identifier = 'acme') => fetchBoard({ provider, identifier }, { fetchImpl });

// Every network dependency is injected; these tests never contact a live board.
test('Greenhouse normalizes a feed, uses fixed endpoint, and preserves observation time', async () => {
  const result = await board('greenhouse', async (url, options) => {
    assert.equal(url, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Accept, 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    return json({ jobs: [gh()], meta: { total: 1 } });
  });
  assert.equal(new Date(result.fetchedAt).toISOString(), result.fetchedAt);
  assert.deepEqual(result.jobs, [{
    provider: 'greenhouse', externalId: '123', title: 'Junior Financial Analyst',
    company: 'acme', location: 'Boston, MA',
    url: 'https://boards.greenhouse.io/acme/jobs/123', text: 'Build & review models.',
    publishedAt: null, observedAt: result.fetchedAt,
  }]);
});

test('Greenhouse uses company name if present and tolerates absent optional fields', async () => {
  const { jobs } = await board('greenhouse', async () => json({ jobs: [gh({
    company_name: 'Acme Finance', location: undefined, content: undefined,
  })] }));
  assert.equal(jobs[0].company, 'Acme Finance');
  assert.equal(jobs[0].text, '');
  assert.equal(jobs[0].location, '');
});

test('Lever normalizes descriptions, lists, and millisecond timestamps', async () => {
  const { jobs, fetchedAt } = await board('lever', async (url, options) => {
    assert.equal(url, 'https://api.lever.co/v0/postings/acme?mode=json&limit=100&skip=0');
    assert.equal(options.redirect, 'manual');
    return json([lever()]);
  });
  assert.deepEqual(jobs, [{
    provider: 'lever', externalId: 'abc-123', title: 'FP&A Analyst', company: 'acme',
    location: 'Remote - US', url: 'https://jobs.lever.co/acme/abc-123',
    text: 'Financial planning Requirements Excel Modeling Apply today',
    publishedAt: '2023-11-14T22:13:20.000Z', observedAt: fetchedAt,
  }]);
});

test('Lever supports plain descriptions and absent optional fields', async () => {
  const { jobs } = await board('lever', async () => json([lever({
    descriptionPlain: 'Plain finance text', additionalPlain: 'Plain ending',
    lists: undefined, categories: undefined, createdAt: undefined,
  })]));
  assert.equal(jobs[0].text, 'Plain finance text Plain ending');
  assert.equal(jobs[0].publishedAt, null);
  assert.equal(jobs[0].location, '');
});

test('HTML flattening removes markup and active content without executing it', async () => {
  const content = '&lt;p&gt;Models &amp;amp; forecasts&lt;/p&gt;' +
    '<script>alert(1)</script><STYLE>body{color:red}</STYLE><!-- secret -->' +
    '<p onclick="evil()">&#x41; &#66; &nbsp; &#x110000; <img src=x onerror="evil()">Good</p>';
  const { jobs } = await board('greenhouse', async () => json({ jobs: [gh({ content })] }));
  assert.equal(jobs[0].text, 'Models & forecasts A B \ufffd Good');
  assert.doesNotMatch(jobs[0].text, /script|alert|onclick|secret|onerror|<p>/);
});

test('only supported providers and strict board slugs are accepted before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('Should not fetch'); };
  for (const identifier of ['', 'https://evil.test', '../acme', 'acme/other', 'acme?x=1',
    'acme#x', 'acme%2fother', ' acme', 'acme\n', 'a'.repeat(101), null, 123]) {
    await assert.rejects(board('greenhouse', fetchImpl, identifier), /Invalid board identifier/);
  }
  await assert.rejects(board('other', fetchImpl), /Unsupported provider/);
  await assert.rejects(fetchBoard({ provider: 'lever', identifier: 'acme' }, { fetchImpl: null }), /fetchImpl/);
  assert.equal(calls, 0);
});

test('missing or invalid required fields reject entire feeds, not partial results', async () => {
  const cases = [
    ['greenhouse', gh, { id: undefined }], ['greenhouse', gh, { id: 0 }],
    ['greenhouse', gh, { id: 1.5 }], ['greenhouse', gh, { id: {} }],
    ['greenhouse', gh, { title: undefined }], ['greenhouse', gh, { title: '  ' }],
    ['greenhouse', gh, { absolute_url: undefined }], ['greenhouse', gh, { absolute_url: '/relative' }],
    ['lever', lever, { id: undefined }], ['lever', lever, { id: '../x' }],
    ['lever', lever, { text: undefined }], ['lever', lever, { text: 12 }],
    ['lever', lever, { hostedUrl: undefined }], ['lever', lever, { hostedUrl: 'javascript:alert(1)' }],
    ['lever', lever, { hostedUrl: 'http://jobs.lever.co/acme/x' }],
    ['lever', lever, { hostedUrl: 'https://user:pass@example.com' }],
    ['lever', lever, { hostedUrl: 'https://example.com/a\nb' }],
  ];
  for (const [provider, fixture, override] of cases) {
    const raw = fixture(override);
    await assert.rejects(board(provider, async () => json(provider === 'lever' ? [raw] : { jobs: [raw] })), /Invalid/);
  }
});

test('feed and optional field schemas are validated', async () => {
  for (const feed of [null, [], {}, { jobs: {} }, { jobs: [null] },
    { jobs: [gh({ location: 'US' })] }, { jobs: [gh({ content: {} })] },
    { jobs: [gh({ company_name: 9 })] }, { jobs: [], meta: { total: 1 } },
    { jobs: [], meta: [] }, { jobs: [], meta: {} }]) {
    await assert.rejects(board('greenhouse', async () => json(feed)), /Invalid/);
  }
  for (const feed of [null, {}, { data: [] }, [null], [lever({ categories: [] })],
    [lever({ lists: {} })], [lever({ lists: [null] })], [lever({ description: 42 })],
    [lever({ categories: { location: [] } })], [lever({ createdAt: 'yesterday' })],
    [lever({ createdAt: -1 })], [lever({ createdAt: 9_000_000_000_000_000 })]]) {
    await assert.rejects(board('lever', async () => json(feed)), /Invalid/);
  }
});

test('empty feeds are valid', async () => {
  assert.deepEqual((await board('greenhouse', async () => json({ jobs: [] }))).jobs, []);
  assert.deepEqual((await board('lever', async () => json([]))).jobs, []);
});

test('duplicates reject rather than silently deduplicate', async () => {
  await assert.rejects(board('greenhouse', async () => json({ jobs: [gh(), gh()] })), /Duplicate job id/);
  await assert.rejects(board('lever', async () => json([lever(), lever()])), /Duplicate job id/);
});

test('HTTP 429 and other non-success responses throw without retries', async () => {
  for (const status of [429, 404, 500]) {
    let calls = 0;
    await assert.rejects(board('lever', async () => {
      calls += 1;
      return new Response('Error', { status });
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test('all redirects and already-followed responses are rejected', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    await assert.rejects(board('greenhouse', async (_, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://evil.test/feed' } });
    }), /redirect rejected/);
  }
  const response = json([]);
  Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(board('lever', async () => response), /redirect rejected/);
});

test('malformed JSON, wrong content type, absent body, and bad UTF-8 reject', async () => {
  await assert.rejects(board('lever', async () => new Response('[broken', {
    headers: { 'content-type': 'application/json' },
  })), /Invalid feed JSON/);
  await assert.rejects(board('lever', async () => new Response('<html>bad</html>')), /content type/);
  await assert.rejects(board('lever', async () => new Response(null)), /missing readable body/);
  await assert.rejects(board('lever', async () => new Response(new Uint8Array([0xff, 0xfe]))), /encoded data/);
});

test('oversize content length rejects and cancels the body without consuming it', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(board('lever', async () => new Response(stream, {
    headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
  })), /byte limit/);
  assert.equal(cancelled, true);
});

test('streaming byte cap applies without a header and with a lying content length', async () => {
  for (const headers of [{}, { 'content-length': '2' }]) {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(256 * 1024)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(board('lever', async () => new Response(stream, { headers })), /byte limit/);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 11, 'reading stops shortly after the cap');
  }
});

test('UTF-8 split across chunks decodes correctly', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify([lever({ description: 'Café €' })]));
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(offset, ++offset));
  } });
  const { jobs } = await board('lever', async () => new Response(stream));
  assert.match(jobs[0].text, /Café €/);
});

test('Lever paginates with bounded skip and terminates on a short page', async () => {
  const skips = [];
  const result = await board('lever', async url => {
    const skip = Number(new URL(url).searchParams.get('skip'));
    skips.push(skip);
    return json(Array.from({ length: skip === 0 ? 100 : 1 }, (_, i) => lever({ id: `id-${skip + i}` })));
  });
  assert.deepEqual(skips, [0, 100]);
  assert.equal(result.jobs.length, 101);
  assert.equal(new Set(result.jobs.map(job => job.observedAt)).size, 1);
});

test('repeated pages are rejected', async () => {
  let calls = 0;
  await assert.rejects(board('lever', async () => {
    calls += 1;
    return json(Array.from({ length: 100 }, (_, i) => lever({ id: `id-${i}` })));
  }), /Duplicate job id/);
  assert.equal(calls, 2);
});

test('job, page-size, and pagination limits reject instead of truncating', async () => {
  await assert.rejects(board('greenhouse', async () => json({
    jobs: Array.from({ length: 2001 }, (_, i) => gh({ id: i + 1 })),
  })), /job limit/);
  await assert.rejects(board('lever', async () => json(
    Array.from({ length: 101 }, (_, i) => lever({ id: `id-${i}` })),
  )), /page size limit/);
  let calls = 0;
  await assert.rejects(board('lever', async url => {
    calls += 1;
    const skip = Number(new URL(url).searchParams.get('skip'));
    return json(Array.from({ length: 100 }, (_, i) => lever({ id: `id-${skip + i}` })));
  }), /pagination limit/);
  assert.equal(calls, 20);
});

test('aggregate byte cap bounds all Lever pages, not just individual responses', async () => {
  let calls = 0;
  await assert.rejects(board('lever', async url => {
    calls += 1;
    const skip = Number(new URL(url).searchParams.get('skip'));
    return json(Array.from({ length: 100 }, (_, i) => lever({
      id: `id-${skip + i}`, description: 'x'.repeat(15_000),
    })));
  }), /byte limit/);
  assert.ok(calls <= 6);
});

test('timeout rejects even when injected fetch ignores the abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const promise = board('lever', async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(promise, /timed out/);
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('timeout covers a stalled streaming body and cancels the reader', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const promise = board('lever', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })));
  const rejected = assert.rejects(promise, /timed out/);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(cancelled, true);
});

test('network and mid-stream failures propagate', async () => {
  await assert.rejects(board('lever', async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(board('lever', async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error('stream failed')); },
  }))), /stream failed/);
});
