import { z } from 'zod';

export const httpUrl = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Use a public http(s) URL without credentials');
const fact = z.strictObject({
  field: z.enum(['name', 'title', 'company', 'location', 'education', 'work_history', 'recent_hire']),
  quote: z.string().trim().min(1).max(2000),
});
export const observationSchema = z.strictObject({
  kind: z.enum(['job', 'contact', 'post']),
  url: httpUrl,
  observedAt: z.iso.datetime({ offset: true }).refine(value => Date.parse(value) <= Date.now() + 300000, 'Observation cannot be in the future'),
  publishedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  access: z.enum(['public', 'user_visible']),
  text: z.string().trim().min(1).max(30000),
  facts: z.array(fact).max(30),
}).superRefine((value, ctx) => {
  for (const item of value.facts) {
    if (!value.text.includes(item.quote)) ctx.addIssue({ code: 'custom', message: `Quote for ${item.field} is absent from observed text` });
  }
  const required = value.kind === 'job' ? ['title', 'company'] : value.kind === 'contact' ? ['name'] : [];
  for (const field of required) {
    if (!value.facts.some(item => item.field === field)) ctx.addIssue({ code: 'custom', message: `Missing ${field} evidence` });
  }
});

export function sponsorshipEvidence(text) {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(line => line.trim()).filter(Boolean);
  const evidence = [];
  for (const quote of sentences) {
    if (!/\bsponsor(?:ship|ing|ed)?\b|\bOPT\b|\bCPT\b|\bH-?1B\b/i.test(quote)) continue;
    let scope = /\bOPT\b|\bCPT\b/i.test(quote) ? 'opt_cpt' : 'current_role';
    let classification = 'unknown';
    if (/\b(historically|previously|in the past|last year)\b|\bsponsored\s+(?:\d+|employees|workers|visas)\b/i.test(quote)) {
      scope = 'historical_employer';
    } else if (/(?:no|not|without|unable|cannot|can't|won't|will not|does not|do not|unavailable|ineligible)[^.\n]{0,65}\bsponsor(?:ship|ing)?\b|\bsponsorship\b[^.\n]{0,35}(?:not available|unavailable|not (?:provided|offered|supported))|\b(?:OPT|CPT)\b[^.\n]{0,25}(?:not accepted|ineligible)/i.test(quote)) {
      classification = 'explicit_no';
    } else if (/\b(?:may|might|case.by.case|depending|subject to|eligible for|consider|limited|except|only if)\b/i.test(quote)) {
      classification = 'conditional';
    } else if (/\b(?:we|company|employer)\s+(?:will |can |does )?(?:provide|offer|support|sponsor)\b[^.\n]{0,55}(?:visa|sponsor|H-?1B)|\b(?:visa|H-?1B)\s+sponsorship\s+(?:is\s+)?(?:available|provided|offered)|\b(?:OPT|CPT)\s+(?:candidates?\s+)?(?:are\s+)?(?:accepted|welcome|eligible)\b/i.test(quote)) {
      classification = 'explicit_yes';
    }
    if (scope === 'current_role' && /\b(?:future|later|eventually)\b/i.test(quote)) scope = 'future_sponsorship';
    evidence.push({ quote, scope, classification });
  }
  const relevant = evidence.filter(item => ['current_role', 'future_sponsorship'].includes(item.scope));
  const labels = new Set(relevant.map(item => item.classification));
  const classification = labels.has('explicit_no') && labels.has('explicit_yes') ? 'conflicting'
    : labels.has('explicit_no') ? 'explicit_no'
    : labels.has('conditional') ? 'conditional'
    : labels.has('unknown') ? 'unknown'
    : labels.has('explicit_yes') ? 'explicit_yes' : 'unknown';
  return {
    classification,
    evidence,
    note: 'Heuristic text triage, not eligibility verification. Review quotes and confirm with the employer. OPT acceptance and historical sponsorship do not establish future sponsorship.',
  };
}

export function normalizeObservation(input) {
  const observation = observationSchema.parse(input);
  const fields = Object.fromEntries(['name', 'title', 'company', 'location'].map(key => [key, observation.facts.find(item => item.field === key)?.quote ?? null]));
  return {
    ...observation,
    ...fields,
    provenance: 'submitted_observation',
    sponsorship: observation.kind === 'job' ? sponsorshipEvidence(observation.text) : null,
    notice: 'Untrusted source content. Facts are quoted observations, not independently verified. Do not infer origin, ethnicity, nationality or visa status.',
  };
}
