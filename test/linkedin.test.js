import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { SEARCH_TERMS } from '../src/linkedin.js';

const job = (id, title, location = 'New York, NY', text = 'Analyze budgets. Visa sponsorship is available.') => ({
  title, company: 'Example Corp', location, url: `https://www.linkedin.com/jobs/view/${id}`, text,
  publishedAt: '2026-09-30', observedAt: '2026-10-02T12:00:00Z', descriptionAvailable: true,
});

async function fixture(t, runBridgeImpl) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-mcp-test-'));
  const store = new Store(directory);
  await store.init();
  const server = createServer(store, { runBridgeImpl });
  const client = new Client({ name: 'linkedin-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, store };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}

async function rejected(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should reject ${JSON.stringify(args)}`);
}

test('LinkedIn tools are registered as read-only open-world tools', async t => {
  const { client } = await fixture(t, async () => ({ status: 'ok' }));
  const { tools } = await client.listTools();
  for (const name of ['search_linkedin_jobs', 'read_linkedin_profile', 'read_linkedin_company_posts']) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.equal(tools.find(item => item.name === 'linkedin_runtime_status').annotations.openWorldHint, false);
});

test('runtime status passes straight through', async t => {
  const requests = [];
  const { client } = await fixture(t, async request => { requests.push(request); return { status: 'unavailable', capabilities: { jobs: false } }; });
  assert.equal((await call(client, 'linkedin_runtime_status')).status, 'unavailable');
  assert.deepEqual(requests, [{ mode: 'status' }]);
});

test('job search runs one capped search per role, filters and triages without saving', async t => {
  const requests = [];
  const { client, store } = await fixture(t, async request => {
    requests.push(request);
    if (request.args.searchTerm === SEARCH_TERMS.financial_analyst) {
      return { status: 'ok', failures: [], requestCount: 4, jobs: [
        job(1, 'Junior Financial Analyst'), job(2, 'Senior Financial Analyst'),
        job(3, 'Financial Analyst', 'London, United Kingdom'), job(4, 'Software Engineer'),
      ] };
    }
    return { status: 'no_results', failures: [], requestCount: 1, jobs: [] };
  });
  const before = store.snapshot();
  const result = await call(client, 'search_linkedin_jobs', { roles: ['financial_analyst', 'risk'], limit: 5, postedWithinDays: 7 });
  assert.deepEqual(requests.map(r => r.args), [
    { searchTerm: 'financial analyst', location: 'United States', limit: 3, hoursOld: 168 },
    { searchTerm: 'risk analyst', location: 'United States', limit: 3, hoursOld: 168 },
  ]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.jobs.map(item => item.title), ['Junior Financial Analyst']);
  assert.equal(result.filteredOut, 3);
  assert.equal(result.jobs[0].provider, 'linkedin');
  assert.equal(result.jobs[0].sponsorship.classification, 'explicit_yes');
  assert.deepEqual(result.jobs[0].match, { roles: ['financial_analyst'], geography: 'US', seniority: 'junior' });
  assert.match(result.notice, /Nothing was saved/);
  assert.deepEqual(store.snapshot(), before);
});

test('a block stops later searches and is never reported as no results', async t => {
  const requests = [];
  const { client } = await fixture(t, async request => {
    requests.push(request);
    return { status: 'rate_limited', reason: 'http_429', failures: [{ status: 'rate_limited', reason: 'http_429' }], jobs: [] };
  });
  const result = await call(client, 'search_linkedin_jobs', {});
  assert.equal(requests.length, 1);
  assert.equal(result.status, 'rate_limited');
  assert.equal(result.skippedSearches, 3);
});

test('partial results survive a later block; unrecognized pages are not no_results', async t => {
  let calls = 0;
  const { client } = await fixture(t, async () => (++calls === 1
    ? { status: 'ok', jobs: [job(1, 'Junior Financial Analyst')] }
    : { status: 'blocked', reason: 'access_gate', jobs: [] }));
  const result = await call(client, 'search_linkedin_jobs', { roles: ['financial_analyst', 'fp_and_a', 'risk'] });
  assert.equal(result.status, 'partial');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.searches.length, 2);

  const { client: other } = await fixture(t, async () => ({ status: 'unrecognized_page', jobs: [] }));
  assert.equal((await call(other, 'search_linkedin_jobs', { roles: ['risk'] })).status, 'unrecognized_page');
});

test('custom keywords replace role terms and do not require a role title match', async t => {
  const requests = [];
  const { client } = await fixture(t, async request => { requests.push(request); return { status: 'ok', jobs: [job(9, 'Treasury Analyst I')] }; });
  const result = await call(client, 'search_linkedin_jobs', { keywords: 'treasury analyst', location: 'Chicago, IL', limit: 3, includeUnknown: false });
  assert.deepEqual(requests.map(r => r.args), [{ searchTerm: 'treasury analyst', location: 'Chicago, IL', limit: 3 }]);
  assert.deepEqual(result.jobs.map(item => item.title), ['Treasury Analyst I']);
});

test('job search input is bounded', async t => {
  const { client } = await fixture(t, async () => assert.fail('bridge should not run'));
  for (const args of [{ limit: 21 }, { limit: 0 }, { keywords: 'a\nb' }, { location: 'x'.repeat(101) },
    { postedWithinDays: 31 }, { roles: ['unknown'] }, { roles: [] }]) {
    await rejected(client, 'search_linkedin_jobs', args);
  }
});

test('profile and post reads validate exact URLs and default to no login', async t => {
  const requests = [];
  const { client } = await fixture(t, async request => {
    requests.push(request);
    return request.args.interactiveLogin ? { status: 'ok', posts: [] } : { status: 'auth_required', reason: 'interactive_login_required' };
  });
  const profile = await call(client, 'read_linkedin_profile', { url: 'https://www.linkedin.com/in/example-person' });
  assert.equal(profile.status, 'auth_required');
  assert.match(profile.notice, /Do not infer origin/);
  await call(client, 'read_linkedin_company_posts', { url: 'https://www.linkedin.com/company/example-corp/', interactiveLogin: true, limit: 2 });
  assert.deepEqual(requests, [
    { mode: 'profile', args: { url: 'https://www.linkedin.com/in/example-person/', interactiveLogin: false, limit: 5 } },
    { mode: 'company_posts', args: { url: 'https://www.linkedin.com/company/example-corp/', interactiveLogin: true, limit: 2 } },
  ]);
  for (const url of ['https://www.linkedin.com/company/example', 'http://www.linkedin.com/in/x', 'https://www.linkedin.com/in/x?trk=a',
    'https://linkedin.com/in/x', 'https://www.linkedin.com/in/x/details/contact-info/', 'https://evil.test/in/x']) {
    await rejected(client, 'read_linkedin_profile', { url });
  }
  await rejected(client, 'read_linkedin_company_posts', { url: 'https://www.linkedin.com/company/x', limit: 6 });
  await rejected(client, 'read_linkedin_profile', { url: 'https://www.linkedin.com/in/x', password: 'secret' });
  assert.equal(requests.length, 2);
});

test('only one browser session runs at a time', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { client } = await fixture(t, async () => { await gate; return { status: 'ok', profile: {} }; });
  const first = call(client, 'read_linkedin_profile', { url: 'https://www.linkedin.com/in/a', interactiveLogin: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await call(client, 'read_linkedin_company_posts', { url: 'https://www.linkedin.com/company/b', interactiveLogin: true });
  assert.equal(second.status, 'busy');
  release();
  assert.equal((await first).status, 'ok');
});
