import { z } from 'zod';
import { matchJob } from './preferences.js';
import { sponsorshipEvidence } from './evidence.js';
import { runBridge } from './python_bridge.js';

// Plain keyword phrases: the guest jobs endpoint is searched once per role, in turn.
export const SEARCH_TERMS = {
  financial_analyst: 'financial analyst',
  fp_and_a: 'FP&A analyst',
  investment_banking: 'investment banking analyst',
  risk: 'risk analyst',
};
const STOP = new Set(['blocked', 'rate_limited', 'auth_required', 'unavailable', 'invalid_request', 'error']);
const NOTICE = 'Untrusted source content. Do not infer origin, ethnicity, nationality or immigration status. Nothing was saved; use ingest_observation with exact quotes to keep a record.';

const urlSchema = kind => z.string().max(140)
  .regex(new RegExp(`^https://www\\.linkedin\\.com/${kind}/[A-Za-z0-9][A-Za-z0-9_-]{0,99}/?$`),
    `Use an exact https://www.linkedin.com/${kind}/<slug> URL without query or fragment`)
  .transform(value => value.replace(/\/?$/, '/'));
const plainText = max => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'No control characters');
// Strict: credential-like extra arguments are rejected, not silently dropped.
const browserArgs = kind => z.strictObject({
  url: urlSchema(kind),
  interactiveLogin: z.boolean().default(false).describe('true only when the user explicitly asked to sign in now. Opens a visible browser for manual login; the session is discarded afterwards.'),
  limit: z.number().int().min(1).max(5).default(5),
});

export function linkedInTools({ runBridgeImpl = runBridge, roleSchema, defaultRoles }) {
  let browserBusy = false;
  const browserCall = async request => {
    if (browserBusy) return { status: 'busy', reason: 'another_browser_session_running' };
    browserBusy = true;
    try { return await runBridgeImpl(request); }
    finally { browserBusy = false; }
  };

  const searchJobs = async ({ roles, keywords, location, limit, postedWithinDays, includeUnknown }) => {
    const selected = roles ?? defaultRoles();
    const plans = keywords ? [{ role: null, searchTerm: keywords }] : selected.map(role => ({ role, searchTerm: SEARCH_TERMS[role] }));
    // Split the cap across searches so total LinkedIn requests stay near the limit.
    const perSearch = Math.max(1, Math.ceil(limit / plans.length));
    const searches = [];
    const jobs = new Map();
    let filteredOut = 0;
    for (const plan of plans) {
      const args = { searchTerm: plan.searchTerm, location, limit: perSearch };
      if (postedWithinDays) args.hoursOld = postedWithinDays * 24;
      const result = await runBridgeImpl({ mode: 'jobs', args });
      searches.push({ ...plan, status: result.status, reason: result.reason, failures: result.failures ?? [], requestCount: result.requestCount ?? 0 });
      for (const job of Array.isArray(result.jobs) ? result.jobs : []) {
        const match = matchJob(job, selected);
        if ((!keywords && !match.roles.length) || match.geography === 'outside_US' || match.seniority === 'senior' ||
            (!includeUnknown && (match.geography === 'unknown' || match.seniority === 'unknown'))) {
          filteredOut += 1;
          continue;
        }
        if (!jobs.has(job.url)) {
          jobs.set(job.url, {
            ...job, kind: 'job', provider: 'linkedin', match,
            sponsorship: sponsorshipEvidence(job.text ?? ''),
            text: (job.text ?? '').slice(0, 6000), textTruncated: (job.text ?? '').length > 6000,
            provenance: 'linkedin_public_guest_search',
          });
        }
      }
      if (STOP.has(result.status)) break;
    }
    const statuses = searches.map(item => item.status);
    const found = [...jobs.values()].slice(0, limit);
    const stopped = statuses.find(status => STOP.has(status));
    const status = stopped ? (found.length ? 'partial' : stopped)
      : statuses.every(item => item === 'no_results') ? 'no_results'
      : statuses.every(item => ['ok', 'no_results'].includes(item)) ? 'ok'
      : found.length ? 'partial' : statuses.find(item => item !== 'no_results');
    return {
      status, searches, jobs: found, filteredOut,
      skippedSearches: plans.length - searches.length,
      note: 'LinkedIn public guest search with the entry-level filter; coverage is partial and results are not saved. Unknown seniority or US eligibility requires review. Sponsorship labels are text triage, not eligibility verification.',
      notice: NOTICE,
    };
  };

  return [
    ['linkedin_runtime_status', 'Check the local Python LinkedIn runtime: packages, browser and which LinkedIn tools can run. Makes no network request.', {},
      () => runBridgeImpl({ mode: 'status' }), true, false],
    ['search_linkedin_jobs', 'Search LinkedIn public guest job listings (US, entry level by default) for the selected roles, read each description and triage sponsorship text. Stops at blocks or rate limits; never retries around them. Nothing is saved.', {
      roles: roleSchema.optional(),
      keywords: plainText(100).optional().describe('Overrides role search terms with one custom search.'),
      location: plainText(100).default('United States'),
      limit: z.number().int().min(1).max(20).default(10),
      postedWithinDays: z.number().int().min(1).max(30).optional(),
      includeUnknown: z.boolean().default(true),
    }, searchJobs, true, true],
    ['read_linkedin_profile', 'Read professional facts (name, headline, up to 5 work and education entries) from one exact LinkedIn profile URL. Requires interactiveLogin=true and the user signing in manually in a visible browser; no credentials pass through this tool. Stops at CAPTCHA, checkpoints or rate limits. Nothing is saved.',
      browserArgs('in'), async args => {
        const result = await browserCall({ mode: 'profile', args });
        return { ...result, notice: NOTICE };
      }, true, true],
    ['read_linkedin_company_posts', 'Read up to 5 recent posts from one exact LinkedIn company URL (for example new-hire welcome posts). Requires interactiveLogin=true and manual sign-in in a visible browser. relativeAge is LinkedIn\'s own label such as "3d"; no exact dates are inferred. A congratulatory post alone does not prove a hire. Nothing is saved.',
      browserArgs('company'), async args => {
        const result = await browserCall({ mode: 'company_posts', args });
        return { ...result, notice: NOTICE };
      }, true, true],
  ];
}
