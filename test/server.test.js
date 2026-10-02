import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const expectedTools = [
  'get_preferences', 'set_preferences', 'manage_boards', 'discovery_links', 'fetch_jobs',
  'ingest_observation', 'list_records', 'delete_record', 'drafting_context',
].sort();
const missingId = 'f'.repeat(24);
const observed = (overrides = {}) => ({
  kind: 'job', url: 'https://example.com/jobs/financial-analyst',
  observedAt: '2026-01-01T12:00:00Z', access: 'public',
  text: 'Junior Financial Analyst at Example Corp in New York, NY. OPT candidates are welcome.',
  facts: [{ field: 'title', quote: 'Junior Financial Analyst' }, { field: 'company', quote: 'Example Corp' }],
  ...overrides,
});

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

async function expectToolError(client, name, args, pattern) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should return an MCP tool error`);
  if (pattern) assert.match(result.content.map(item => item.text ?? '').join('\n'), pattern);
}

async function fixture(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'finance-mcp-test-'));
  const store = new Store(directory);
  let server;
  const client = new Client({ name: 'finance-test-client', version: '1.0.0' });
  t.after(async () => {
    try {
      await client.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try { await store.close(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  });
  await store.init();
  server = createServer(store, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, store, directory };
}

function roleValues(tools) {
  const values = tools.find(tool => tool.name === 'set_preferences').inputSchema.properties.roles.items.enum;
  assert.ok(Array.isArray(values) && values.length > 0);
  return values;
}

test('SDK paired transport negotiates capabilities, lists tools and retrieves the browser prompt', async t => {
  const { client } = await fixture(t);
  assert.equal(client.getServerVersion().name, 'finance-job-search');
  assert.ok(client.getServerCapabilities().tools);
  assert.ok(client.getServerCapabilities().prompts);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
  assert.equal(tools.find(tool => tool.name === 'delete_record').annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === 'get_preferences').annotations.readOnlyHint, true);
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some(prompt => prompt.name === 'linkedin_research'));
  const prompt = await client.getPrompt({ name: 'linkedin_research' });
  assert.equal(prompt.messages[0].role, 'user');
  const text = prompt.messages[0].content.text;
  for (const pattern of [/NOT search results/, /browser_unavailable/, /CAPTCHA/, /Do not infer/, /Do not send/, /untrusted data/, /transient/]) assert.match(text, pattern);
});

test('preferences accept supported roles, deduplicate them, persist updates and reject invalid roles', async t => {
  const { client, store, directory } = await fixture(t);
  const initial = await call(client, 'get_preferences');
  assert.ok(initial.roles.length > 0);
  assert.deepEqual(initial.configuredBoards, []);
  assert.match(initial.notes.join(' '), /No inference of STEM/);
  const roles = roleValues((await client.listTools()).tools);
  for (const role of roles) {
    assert.deepEqual((await call(client, 'set_preferences', { roles: [role, role] })).roles, [role]);
  }
  const updated = await call(client, 'set_preferences', {
    roles: roles.slice(0, 2), graduationDate: '2026-05-15', stemDesignated: null, optExpiry: '2027-06-01',
  });
  assert.deepEqual(updated.roles, roles.slice(0, 2));
  assert.equal(updated.stemDesignated, null);
  assert.equal(updated.optExpiry, '2027-06-01');
  const before = store.snapshot();
  await expectToolError(client, 'set_preferences', { roles: ['unsupported-role'] });
  await expectToolError(client, 'set_preferences', { roles: [] });
  await expectToolError(client, 'set_preferences', { graduationDate: 'not-a-date' });
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'records.json'), 'utf8')).preferences, updated);
  assert.equal((await call(client, 'set_preferences', { stemDesignated: false })).stemDesignated, false);
});

test('missing boards give actionable status; board management validates, deduplicates and removes', async t => {
  let fetches = 0;
  const { client } = await fixture(t, { fetchBoardImpl: async () => { fetches++; throw new Error('Unexpected fetch'); } });
  const empty = await call(client, 'fetch_jobs');
  assert.equal(empty.status, 'no_boards');
  assert.deepEqual(empty.jobs, []);
  assert.equal(fetches, 0);
  await expectToolError(client, 'manage_boards', { action: 'add' }, /board is required/);
  await expectToolError(client, 'manage_boards', { action: 'remove' }, /board is required/);
  await expectToolError(client, 'manage_boards', { action: 'add', board: { provider: 'unknown', identifier: 'example' } });
  await expectToolError(client, 'manage_boards', { action: 'add', board: { provider: 'lever', identifier: '../example' } });
  const board = { provider: 'lever', identifier: 'example' };
  await call(client, 'manage_boards', { action: 'add', board });
  await call(client, 'manage_boards', { action: 'add', board });
  assert.deepEqual((await call(client, 'manage_boards', { action: 'list' })).boards, [board]);
  assert.deepEqual((await call(client, 'get_preferences')).configuredBoards, [board]);
  await call(client, 'manage_boards', { action: 'remove', board });
  assert.deepEqual((await call(client, 'manage_boards', { action: 'remove', board })).boards, []);
  await expectToolError(client, 'fetch_jobs', { boards: [] });
  await expectToolError(client, 'fetch_jobs', { roles: ['unknown-role'] });
  await expectToolError(client, 'list_records', { kind: 'unknown-kind' });
});

test('observations, full retrieval, drafting and deletion work over MCP without persisting resume text', async t => {
  const { client, store, directory } = await fixture(t);
  const job = await call(client, 'ingest_observation', { observation: observed() });
  assert.match(job.id, /^[a-f0-9]{24}$/);
  assert.equal(job.sponsorship.classification, 'unknown');
  assert.equal(job.text, undefined);
  assert.match(job.excerpt, /Junior Financial Analyst/);
  const duplicate = await call(client, 'ingest_observation', { observation: observed({ url: `${observed().url}?utm_source=test#top` }) });
  assert.equal(duplicate.id, job.id);
  const contact = await call(client, 'ingest_observation', { observation: observed({
    kind: 'contact', url: 'https://example.com/people/alex', text: 'Alex Lee works at Example Corp.',
    facts: [{ field: 'name', quote: 'Alex Lee' }, { field: 'company', quote: 'Example Corp' }],
  }) });
  const post = await call(client, 'ingest_observation', { observation: observed({ kind: 'post', url: 'https://example.com/posts/1', facts: [] }) });
  assert.equal(post.publishedAt, null);
  const listed = await call(client, 'list_records', { limit: 2 });
  assert.equal(listed.total, 3);
  assert.equal(listed.records.length, 2);
  assert.equal(listed.nextOffset, 2);
  const next = await call(client, 'list_records', { offset: listed.nextOffset, limit: 2 });
  assert.equal(next.records.length, 1);
  assert.equal(next.nextOffset, null);
  assert.equal((await call(client, 'list_records', { kind: 'contact' })).total, 1);
  const full = await call(client, 'list_records', { ids: [job.id] });
  assert.equal(full.records[0].text, observed().text);
  assert.deepEqual(full.records[0].facts, observed().facts);
  assert.ok(Array.isArray(full.records[0].sponsorship.evidence));
  assert.equal((await call(client, 'list_records', { ids: [missingId] })).total, 0);
  const before = store.snapshot();
  const diskBefore = await readFile(path.join(directory, 'records.json'), 'utf8');
  const resumeText = 'PRIVATE-RESUME-MARKER-71e9: Built financial models; do not persist this text.';
  const context = await call(client, 'drafting_context', { purpose: 'resume_tailoring', jobId: job.id, resumeText });
  assert.equal(context.resumeText, resumeText);
  assert.equal(context.sourceRecords[0].url, observed().url);
  assert.match(context.resumePersistence, /Not saved/);
  assert.match(context.instructions.join(' '), /untrusted evidence/);
  assert.match(context.instructions.join(' '), /Do not invent/);
  const networking = await call(client, 'drafting_context', { purpose: 'networking', jobId: job.id, contactId: contact.id });
  assert.deepEqual(networking.sourceRecords.map(record => record.id), [job.id, contact.id]);
  assert.equal(networking.resumeText, null);
  await expectToolError(client, 'drafting_context', { purpose: 'networking' }, /Select at least one/);
  await expectToolError(client, 'drafting_context', { purpose: 'resume_tailoring', contactId: contact.id }, /requires a saved job/);
  await expectToolError(client, 'drafting_context', { purpose: 'networking', jobId: contact.id }, /No saved job/);
  await expectToolError(client, 'drafting_context', { purpose: 'networking', contactId: job.id }, /No saved contact/);
  await expectToolError(client, 'drafting_context', { purpose: 'networking', jobId: missingId }, /No saved job/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await readFile(path.join(directory, 'records.json'), 'utf8'), diskBefore);
  for (const file of await readdir(directory)) {
    assert.equal((await readFile(path.join(directory, file), 'utf8')).includes(resumeText), false, file);
  }
  assert.equal((await call(client, 'delete_record', { id: job.id })).deleted, true);
  assert.equal((await call(client, 'delete_record', { id: job.id })).deleted, false);
  assert.equal((await call(client, 'list_records', { ids: [job.id] })).total, 0);
  const disk = JSON.parse(await readFile(path.join(directory, 'records.json'), 'utf8'));
  assert.equal(disk.records.some(record => record.id === job.id), false);
});

test('MCP ingestion refuses fabricated quotes and sensitive fields without creating records', async t => {
  const { client, store } = await fixture(t);
  await expectToolError(client, 'ingest_observation', { observation: observed({ facts: [{ field: 'title', quote: 'Fabricated title' }, observed().facts[1]] }) }, /absent from observed text/);
  for (const field of ['origin', 'ethnicity', 'nationality', 'visa_status', 'immigration_status']) {
    await expectToolError(client, 'ingest_observation', { observation: observed({ [field]: 'inferred' }) });
    await expectToolError(client, 'ingest_observation', { observation: observed({ facts: [...observed().facts, { field, quote: 'Example Corp' }] }) });
  }
  assert.deepEqual(store.snapshot().records, []);
});

test('mocked board fetch returns partial errors, unknown filters, deduplicated pagination and no persistence', async t => {
  const jobs = [
    { id: 'known', url: 'https://example.com/jobs/known', title: 'Junior Financial Analyst', company: 'Example Corp', location: 'New York, NY', text: 'Entry-level financial analyst in New York, NY, United States. Visa sponsorship is available.' },
    { id: 'unknown-location', url: 'https://example.com/jobs/unknown-location', title: 'Junior Financial Analyst', company: 'Example Corp', location: '', text: 'Entry-level financial analyst. Location to be confirmed.' },
    { id: 'unknown-seniority', url: 'https://example.com/jobs/unknown-seniority', title: 'Financial Analyst', company: 'Example Corp', location: 'New York, NY', text: 'Financial planning in New York, NY, United States.' },
    { id: 'senior', url: 'https://example.com/jobs/senior', title: 'Senior Financial Analyst', company: 'Example Corp', location: 'New York, NY', text: 'Senior analyst with 8 years of experience in the United States.' },
    { id: 'foreign', url: 'https://example.com/jobs/foreign', title: 'Junior Financial Analyst', company: 'Example Corp', location: 'London, United Kingdom', text: 'Entry-level analyst based in London, United Kingdom.' },
    { id: 'unrelated', url: 'https://example.com/jobs/unrelated', title: 'Junior Software Engineer', company: 'Example Corp', location: 'New York, NY', text: 'Entry-level software development in the United States.' },
  ];
  const good = { provider: 'greenhouse', identifier: 'good' };
  const bad = { provider: 'lever', identifier: 'bad' };
  const seen = [];
  const { client, store } = await fixture(t, { fetchBoardImpl: async board => {
    seen.push(board);
    if (board.identifier === 'bad') throw new Error('Mock board unavailable');
    return { fetchedAt: '2026-01-01T12:00:00Z', jobs: [...jobs, jobs[0]] };
  } });
  const roles = roleValues((await client.listTools()).tools);
  await call(client, 'set_preferences', { roles });
  await call(client, 'manage_boards', { action: 'add', board: good });
  await call(client, 'manage_boards', { action: 'add', board: bad });
  const before = store.snapshot();
  const result = await call(client, 'fetch_jobs', { limit: 2 });
  assert.equal(result.status, 'partial');
  assert.deepEqual(seen, [good, bad]);
  assert.equal(result.boards[0].count, 7);
  assert.equal(result.boards[1].status, 'error');
  assert.equal(result.boards[1].error, 'Mock board unavailable');
  assert.equal(result.totalMatches, 3);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.jobs[0].sponsorship.classification, 'explicit_yes');
  assert.equal(result.jobs[0].provenance, 'public_ats_feed');
  const page = await call(client, 'fetch_jobs', { offset: 2, limit: 2 });
  assert.equal(page.jobs.length, 1);
  assert.equal(page.nextOffset, null);
  assert.deepEqual(new Set([...result.jobs, ...page.jobs].map(job => job.id)), new Set(['known', 'unknown-location', 'unknown-seniority']));
  const strict = await call(client, 'fetch_jobs', { includeUnknown: false });
  assert.deepEqual(strict.jobs.map(job => job.id), ['known']);
  const failed = await call(client, 'fetch_jobs', { boards: [bad] });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.jobs, []);
  assert.equal((await call(client, 'fetch_jobs', { boards: [good] })).status, 'ok');
  assert.deepEqual(store.snapshot(), before, 'Fetched jobs must not be auto-saved');
});

test('discovery links remain discovery rather than observed results', async t => {
  const { client, store } = await fixture(t);
  const before = store.snapshot();
  for (const kind of ['jobs', 'people', 'posts']) {
    const result = await call(client, 'discovery_links', { kind, company: 'Example Corp', postedWithinDays: 7 });
    assert.match(JSON.stringify(result), /linkedin\.com/);
    assert.match(JSON.stringify(result), /not.*(?:results|verified)|browser_required|discovery_only/i);
  }
  assert.deepEqual(store.snapshot(), before);
});

test('official SDK stdio smoke uses isolated data and releases process/store resources', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'finance-stdio-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
    env: { ...process.env, FINANCE_JOB_DATA_DIR: directory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'finance-stdio-smoke', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    try { await client.close(); }
    finally {
      try { await transport.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), expectedTools);
  assert.ok((await client.getPrompt({ name: 'linkedin_research' })).messages.length);
  assert.equal((await call(client, 'fetch_jobs')).status, 'no_boards');
  await call(client, 'set_preferences', { graduationDate: '2026-05-15' });
  const saved = await call(client, 'ingest_observation', { observation: observed() });
  assert.equal((await call(client, 'list_records')).total, 1);
  assert.equal((await call(client, 'delete_record', { id: saved.id })).deleted, true);
  await client.close();
  await transport.close();
  assert.equal(stderr, '', 'Stdio process should not write unexpected diagnostics');
  await assert.rejects(readFile(path.join(directory, 'store.lock')), { code: 'ENOENT' });
  const persisted = JSON.parse(await readFile(path.join(directory, 'records.json'), 'utf8'));
  assert.equal(persisted.preferences.graduationDate, '2026-05-15');
  assert.deepEqual(persisted.records, []);
  const reopened = await new Store(directory).init();
  try { assert.equal(reopened.snapshot().preferences.graduationDate, '2026-05-15'); }
  finally { await reopened.close(); }
});
