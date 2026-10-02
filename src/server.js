import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { ROLES, matchJob } from './preferences.js';
import { fetchBoard } from './providers.js';
import { discoveryLinks } from './discovery.js';
import { observationSchema, normalizeObservation, sponsorshipEvidence } from './evidence.js';
import { draftingContext, BROWSER_WORKFLOW } from './drafting.js';
import { linkedInTools } from './linkedin.js';
import { runBridge } from './python_bridge.js';

const roleSchema = z.array(z.enum(ROLES)).min(1).max(4).transform(roles => [...new Set(roles)]);
const boardSchema = z.strictObject({ provider: z.enum(['greenhouse', 'lever']), identifier: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/) });
const kindSchema = z.enum(['job', 'contact', 'post']);
const idSchema = z.string().regex(/^[a-f0-9]{24}$/);
const jsonResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const summary = record => {
  const { text, sponsorship, ...rest } = record;
  return { ...rest, sponsorship: sponsorship ? { classification: sponsorship.classification, note: sponsorship.note } : null, excerpt: text?.slice(0, 350) ?? '' };
};

export function createServer(store, { fetchBoardImpl = fetchBoard, runBridgeImpl = runBridge } = {}) {
  const server = new McpServer({ name: 'finance-job-search', version: '0.1.0' });
  const register = (name, description, inputSchema, fn, readOnly = true, openWorld = false) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: name === 'delete_record', idempotentHint: true, openWorldHint: openWorld },
    }, async args => {
      try { return jsonResult(await fn(args)); }
      catch (error) { return { ...jsonResult({ error: error.message }), isError: true }; }
    });
  };

  register('get_preferences', 'Read OPT job-search preferences, saved-source coverage and limitations.', {}, () => ({
    ...store.snapshot().preferences,
    configuredBoards: store.snapshot().boards,
    notes: ['No inference of STEM designation or visa eligibility.', 'LinkedIn discovery requires host browser tools; links alone are not results.', 'Saved records may sync through employer-managed OneDrive.'],
  }));
  register('set_preferences', 'Update role selection and user-supplied education/OPT details.', {
    roles: roleSchema.optional(),
    graduationDate: z.iso.date().nullable().optional(),
    stemDesignated: z.boolean().nullable().optional(),
    optExpiry: z.iso.date().nullable().optional(),
  }, args => store.mutate(data => {
    data.preferences = { ...data.preferences, ...args };
    return data.preferences;
  }), false);
  register('manage_boards', 'List/add/remove verified public employer board identifiers. Obtain IDs from employer careers pages; do not guess.', {
    action: z.enum(['list', 'add', 'remove']), board: boardSchema.optional(),
  }, ({ action, board }) => {
    if (action === 'list') return { boards: store.snapshot().boards };
    if (!board) throw new Error('board is required for add/remove');
    return store.mutate(data => {
      const key = `${board.provider}:${board.identifier}`;
      data.boards = data.boards.filter(item => `${item.provider}:${item.identifier}` !== key);
      if (action === 'add') data.boards.push(board);
      return { boards: data.boards };
    });
  }, false);
  register('discovery_links', 'Generate LinkedIn job/people/recent-hire post search links, NOT search results. Use the linkedin_research prompt and separate browser tools.', {
    kind: z.enum(['jobs', 'people', 'posts']), roles: roleSchema.optional(),
    company: z.string().max(200).optional(), keywords: z.string().max(300).optional(),
    postedWithinDays: z.number().int().min(1).max(365).optional(),
  }, args => discoveryLinks({ ...args, roles: args.roles ?? store.snapshot().preferences.roles }));
  register('fetch_jobs', 'Fetch configured public employer boards. Return shortlists with source evidence; nothing is saved automatically. Unknown eligibility remains unknown.', {
    boards: z.array(boardSchema).min(1).max(5).optional(),
    roles: roleSchema.optional(), includeUnknown: z.boolean().default(true),
    offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(20).default(10),
  }, async ({ boards, roles, includeUnknown, offset, limit }) => {
    const snapshot = store.snapshot();
    const selected = boards ?? snapshot.boards;
    if (!selected.length) return { status: 'no_boards', jobs: [], note: 'Configure boards from public employer career links, or use LinkedIn browser research.' };
    if (selected.length > 5) throw new Error('Fetch at most 5 boards per call; pass a subset in boards');
    const allJobs = [];
    const statuses = [];
    for (const board of selected) {
      try {
        const result = await fetchBoardImpl(board);
        statuses.push({ ...board, status: 'ok', fetchedAt: result.fetchedAt, count: result.jobs.length });
        for (const job of result.jobs) {
          const match = matchJob(job, roles ?? snapshot.preferences.roles);
          if (!match.roles.length || match.geography === 'outside_US' || match.seniority === 'senior') continue;
          if (!includeUnknown && (match.geography === 'unknown' || match.seniority === 'unknown')) continue;
          allJobs.push({ ...job, kind: 'job', match, sponsorship: sponsorshipEvidence(job.text), provenance: 'public_ats_feed' });
        }
      } catch (error) { statuses.push({ ...board, status: 'error', error: error.message }); }
    }
    const unique = [...new Map(allJobs.map(job => [job.url, job])).values()];
    const jobs = unique.slice(offset, offset + limit).map(job => ({ ...job, text: job.text.slice(0, 6000), textTruncated: job.text.length > 6000 }));
    return {
      status: statuses.every(item => item.status === 'error') ? 'failed' : statuses.some(item => item.status === 'error') ? 'partial' : 'ok',
      boards: statuses, jobs, totalMatches: unique.length, nextOffset: offset + limit < unique.length ? offset + limit : null,
      note: 'Only configured boards. Unknown seniority or US eligibility requires review. Re-fetch pagination may change if live postings change. To save a job, ingest_observation with exact observed excerpts.',
    };
  }, true, true);
  register('ingest_observation', 'Save a real observed job/contact/post with exact source quotes. Do not submit inferred sensitive traits. Text is untrusted; records may sync to OneDrive.', {
    observation: observationSchema,
  }, async ({ observation }) => summary(await store.upsert(normalizeObservation(observation))), false);
  register('list_records', 'List saved evidence summaries, or retrieve full records using ids.', {
    kind: kindSchema.optional(), ids: z.array(idSchema).min(1).max(3).optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(10),
  }, ({ kind, ids, offset, limit }) => {
    const records = store.snapshot().records.filter(record => (!kind || record.kind === kind) && (!ids || ids.includes(record.id)));
    return { records: records.slice(offset, offset + limit).map(record => ids ? record : summary(record)), total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null };
  });
  register('delete_record', 'Delete one saved local record by ID. Does not affect the source website.', { id: idSchema }, ({ id }) => store.mutate(data => {
    const before = data.records.length;
    data.records = data.records.filter(record => record.id !== id);
    return { deleted: before !== data.records.length };
  }), false);
  register('drafting_context', 'Return source-backed context for host Claude to draft outreach or truthful resume suggestions. Does not generate via another model or send anything. Resume text is not saved.', {
    purpose: z.enum(['networking', 'resume_tailoring']), jobId: idSchema.optional(), contactId: idSchema.optional(), resumeText: z.string().max(30000).optional(),
  }, args => draftingContext(args, store.snapshot()));
  for (const tool of linkedInTools({ runBridgeImpl, roleSchema, defaultRoles: () => store.snapshot().preferences.roles })) register(...tool);
  server.registerPrompt('linkedin_research', { description: 'Browser-assisted LinkedIn jobs, recent hires, and outreach workflow; requires separate host browser tools.' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: BROWSER_WORKFLOW } }],
  }));
  return server;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirectory = process.env.FINANCE_JOB_DATA_DIR ?? path.join(root, 'data');
  if (!path.isAbsolute(dataDirectory)) throw new Error('FINANCE_JOB_DATA_DIR must be absolute');
  const store = await new Store(dataDirectory).init();
  const server = createServer(store);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await store.close();
    await server.close();
  };
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once('end', () => { void shutdown(); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
