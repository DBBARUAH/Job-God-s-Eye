import test from 'node:test';
import assert from 'node:assert/strict';
import { observationSchema, normalizeObservation, sponsorshipEvidence } from '../src/evidence.js';

const observation = (overrides = {}) => ({
  kind: 'job', url: 'https://example.com/jobs/analyst',
  observedAt: '2026-01-01T12:00:00Z', access: 'public',
  text: 'Financial Analyst at Example Corp. OPT candidates are welcome.',
  facts: [{ field: 'title', quote: 'Financial Analyst' }, { field: 'company', quote: 'Example Corp' }],
  ...overrides,
});

for (const { name, text, classification, evidence } of [
  { name: 'no evidence stays unknown', text: 'Financial Analyst based in New York.', classification: 'unknown', evidence: [] },
  { name: 'unresolved sponsorship stays unknown', text: 'Ask your recruiter about visa sponsorship.', classification: 'unknown', evidence: [['current_role', 'unknown']] },
  { name: 'OPT acceptance alone is not sponsorship', text: 'OPT candidates are welcome.', classification: 'unknown', evidence: [['opt_cpt', 'explicit_yes']] },
  { name: 'CPT rejection is separate from sponsorship', text: 'CPT not accepted.', classification: 'unknown', evidence: [['opt_cpt', 'explicit_no']] },
  { name: 'future sponsorship is separately scoped', text: 'We will provide visa sponsorship in the future.', classification: 'explicit_yes', evidence: [['future_sponsorship', 'explicit_yes']] },
  { name: 'negative sponsorship is explicit', text: 'We cannot provide visa sponsorship.', classification: 'explicit_no', evidence: [['current_role', 'explicit_no']] },
  { name: 'postfixed denial is negative', text: 'Visa sponsorship is not available.', classification: 'explicit_no', evidence: [['current_role', 'explicit_no']] },
  { name: 'conditional sponsorship is not a guarantee', text: 'We may provide visa sponsorship.', classification: 'conditional', evidence: [['current_role', 'conditional']] },
  { name: 'opposing statements conflict', text: 'Visa sponsorship is available. We cannot provide visa sponsorship.', classification: 'conflicting', evidence: [['current_role', 'explicit_yes'], ['current_role', 'explicit_no']] },
  { name: 'historical sponsorship proves no current eligibility', text: 'Previously we sponsored employees.', classification: 'unknown', evidence: [['historical_employer', 'unknown']] },
  { name: 'sponsored worker counts are historical', text: 'We sponsored 20 workers.', classification: 'unknown', evidence: [['historical_employer', 'unknown']] },
  { name: 'OPT acceptance does not cancel future refusal', text: 'OPT candidates are welcome. We cannot provide visa sponsorship in the future.', classification: 'explicit_no', evidence: [['opt_cpt', 'explicit_yes'], ['future_sponsorship', 'explicit_no']] },
]) {
  test(`sponsorship: ${name}`, () => {
    const result = sponsorshipEvidence(text);
    assert.equal(result.classification, classification);
    assert.deepEqual(result.evidence.map(item => [item.scope, item.classification]), evidence);
    for (const item of result.evidence) assert.ok(text.includes(item.quote), 'Evidence must quote the source verbatim');
    assert.match(result.note, /not eligibility verification/);
  });
}

test('normalization retains exact facts, provenance and unknown publication date', () => {
  const input = observation();
  const before = structuredClone(input);
  const result = normalizeObservation(input);
  assert.deepEqual(input, before);
  assert.equal(result.title, 'Financial Analyst');
  assert.equal(result.company, 'Example Corp');
  assert.equal(result.name, null);
  assert.equal(result.location, null);
  assert.equal(result.publishedAt, null);
  assert.equal(result.provenance, 'submitted_observation');
  assert.equal(result.sponsorship.classification, 'unknown');
  assert.match(result.notice, /Untrusted source content/);
});

test('fabricated or paraphrased quotes and missing required facts are refused', () => {
  for (const facts of [
    [{ field: 'title', quote: 'Senior Financial Analyst' }, { field: 'company', quote: 'Example Corp' }],
    [{ field: 'title', quote: 'financial analyst' }, { field: 'company', quote: 'Example Corp' }],
    [{ field: 'title', quote: 'Financial Analyst' }], [],
  ]) assert.equal(observationSchema.safeParse(observation({ facts })).success, false);
  assert.throws(() => normalizeObservation(observation({ facts: [{ field: 'company', quote: 'Fabricated Ltd' }] })), /absent from observed text/);
  assert.equal(observationSchema.safeParse(observation({ kind: 'contact', facts: [] })).success, false);
});

test('future observation timestamps and unsafe source URLs are refused', () => {
  assert.equal(observationSchema.safeParse(observation({ observedAt: new Date(Date.now() + 3600000).toISOString() })).success, false);
  for (const url of ['file:///private/resume', 'javascript:alert(1)', 'https://user:password@example.com/profile']) {
    assert.equal(observationSchema.safeParse(observation({ url })).success, false, url);
  }
});

test('sensitive fields and unrecognized properties are refused by strict schemas', () => {
  for (const field of ['origin', 'ethnicity', 'nationality', 'visa_status', 'immigration_status']) {
    assert.equal(observationSchema.safeParse(observation({ [field]: 'inferred' })).success, false, field);
    assert.equal(observationSchema.safeParse(observation({ facts: [...observation().facts, { field, quote: 'Example Corp' }] })).success, false, field);
  }
  assert.equal(observationSchema.safeParse(observation({ facts: [{ field: 'title', quote: 'Financial Analyst', nationality: 'inferred' }, observation().facts[1]] })).success, false);
});

test('contact and post observations preserve quotes without inferring sponsorship', () => {
  const contact = normalizeObservation(observation({ kind: 'contact', text: 'Alex Lee joined Example Corp.', facts: [{ field: 'name', quote: 'Alex Lee' }] }));
  assert.equal(contact.name, 'Alex Lee');
  assert.equal(contact.sponsorship, null);
  const post = normalizeObservation(observation({ kind: 'post', facts: [] }));
  assert.equal(post.publishedAt, null);
  assert.equal(post.sponsorship, null);
});
