import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, DEFAULT_PREFERENCES, matchJob } from '../src/preferences.js';
import { discoveryLinks } from '../src/discovery.js';

test('preference defaults match the contract and cannot be mutated', () => {
  assert.deepEqual(ROLES, ['financial_analyst', 'fp_and_a', 'investment_banking', 'risk']);
  assert.deepEqual(DEFAULT_PREFERENCES, {
    roles: ROLES, geography: 'US', seniority: 'junior', degree: 'MS Finance',
    workAuthorization: 'OPT', graduationDate: null, stemDesignated: null, optExpiry: null,
  });
  assert.ok(Object.isFrozen(DEFAULT_PREFERENCES));
  assert.ok(Object.isFrozen(ROLES));
});

test('role matching uses titles and respects role filters', () => {
  const fixtures = [
    ['Junior Financial Analyst', ['financial_analyst']],
    ['Finance Analyst', ['financial_analyst']],
    ['FP&A Analyst', ['fp_and_a']],
    ['FP and A Analyst', ['fp_and_a']],
    ['Financial Planning & Analysis Associate', ['fp_and_a']],
    ['Financial Planning and Analysis Intern', ['fp_and_a']],
    ['Investment Banking Analyst', ['investment_banking']],
    ['Investment Banker', ['investment_banking']],
    ['Credit Risk Analyst', ['risk']],
    ['Market Risk Associate', ['risk']],
    ['Risk Management Intern', ['risk']],
    ['Risk Analyst', ['risk']],
    ['Financial Analyst, FP&A', ['financial_analyst', 'fp_and_a']],
  ];
  for (const [title, roles] of fixtures) assert.deepEqual(matchJob({ title }).roles, roles, title);
  assert.deepEqual(matchJob({ title: 'Financial Analyst, FP&A' }, ['fp_and_a']).roles, ['fp_and_a']);
  assert.deepEqual(matchJob({ title: 'Financial Analyst' }, ['risk']).roles, []);
  assert.deepEqual(matchJob({ title: 'Financial Analyst' }, []).roles, []);
  assert.deepEqual(matchJob({ title: 'Financial Analyst' }, ['financial_analyst', 'financial_analyst']).roles, ['financial_analyst']);
});

test('unrelated titles and description boilerplate do not establish a role', () => {
  for (const title of ['Software Engineer', 'Financial Advisor', 'Investment Analyst',
    'Accounting Clerk', 'Risky Business Developer', 'Banking Customer Service']) {
    assert.deepEqual(matchJob({ title, text: 'Work with financial analysts, FP&A, investment banking and risk management.' }).roles, []);
  }
  assert.deepEqual(matchJob({ text: 'Financial Analyst in United States; entry level.' }), {
    roles: [], geography: 'unknown', seniority: 'unknown',
  });
  assert.deepEqual(matchJob(null), { roles: [], geography: 'unknown', seniority: 'unknown' });
});

test('geography is conservative and never confirms global remote as US', () => {
  const fixtures = [
    ['United States', 'US'], ['Remote - US', 'US'], ['Remote (USA)', 'US'],
    ['U.S.', 'US'], ['Boston, MA', 'US'], ['New York, NY', 'US'],
    ['San Francisco, CA', 'US'], ['Austin, Texas', 'US'],
    ['London, United Kingdom', 'outside_US'], ['Toronto, Canada', 'outside_US'],
    ['Bengaluru, India', 'outside_US'], ['Sydney, Australia', 'outside_US'],
    ['US / Canada', 'unknown'], ['Worldwide', 'unknown'], ['Global remote', 'unknown'],
    ['Remote anywhere (US welcome)', 'unknown'], ['Remote', 'unknown'],
    ['North America', 'unknown'], ['CA', 'unknown'], ['IN', 'unknown'],
    ['Paris', 'unknown'], ['New York', 'unknown'], ['', 'unknown'],
    ['Global / United States', 'unknown'], ['Remote - outside US', 'unknown'],
    ['Remote (non-US)', 'unknown'],
  ];
  for (const [location, expected] of fixtures) {
    assert.equal(matchJob({ location, text: 'United States benefits, global offices' }).geography, expected, location);
  }
});

test('seniority requires explicit title evidence; senior terms override junior terms', () => {
  for (const title of ['Junior Financial Analyst', 'Jr. Risk Analyst', 'Entry-Level FP&A Analyst',
    'Investment Banking Intern', 'Financial Analyst I', 'Graduate Risk Analyst']) {
    assert.equal(matchJob({ title }).seniority, 'junior', title);
  }
  for (const title of ['Senior Financial Analyst', 'Sr. FP&A Analyst', 'Risk Manager',
    'Director of Investment Banking', 'VP Finance', 'Financial Analyst II',
    'Lead Risk Analyst', 'Senior Analyst, Graduate Program']) {
    assert.equal(matchJob({ title }).seniority, 'senior', title);
  }
  for (const title of ['Financial Analyst', 'Investment Banking Associate', '', 'Financial Analyst Relations']) {
    assert.equal(matchJob({ title, text: 'Entry level, 0-2 years. Reports to senior manager.' }).seniority, 'unknown', title);
  }
});

test('invalid role filters reject in both public helpers', () => {
  for (const roles of [null, 'risk', ['bogus'], [null], {}]) {
    assert.throws(() => matchJob({}, roles), /roles/);
    assert.throws(() => discoveryLinks({ kind: 'jobs', roles }), /roles/);
  }
});

test('jobs discovery uses LinkedIn supported US, experience, and recency filters', () => {
  const result = discoveryLinks({ kind: 'jobs', roles: ['fp_and_a'], postedWithinDays: 7 });
  assert.equal(result.status, 'links_only');
  assert.equal(result.requiresBrowser, true);
  assert.equal(result.links.length, 1);
  const url = new URL(result.links[0].url);
  assert.equal(url.origin, 'https://www.linkedin.com');
  assert.equal(url.pathname, '/jobs/search/');
  assert.equal(url.searchParams.get('location'), 'United States');
  assert.equal(url.searchParams.get('geoId'), '103644278');
  assert.equal(url.searchParams.get('f_E'), '1,2');
  assert.equal(url.searchParams.get('f_TPR'), 'r604800');
  assert.match(url.searchParams.get('keywords'), /FP&A/);
  assert.doesNotMatch(url.searchParams.get('keywords'), /investment banking|financial analyst/);
  assert.match(result.notes.join(' '), /authorization|sponsorship/);
});

test('special characters round-trip without injecting query parameters or fragments', () => {
  const company = 'A&B / 日本 #1?geoId=evil';
  const keywords = '"MS Finance" + OPT & f_E=9 = 100%';
  for (const kind of ['jobs', 'people', 'posts']) {
    const result = discoveryLinks({ kind, roles: [], company, keywords });
    const url = new URL(result.links[0].url);
    assert.equal(url.hash, '');
    assert.equal(url.origin, 'https://www.linkedin.com');
    assert.ok(url.searchParams.get('keywords').includes(`${company} ${keywords}`));
    assert.equal(url.searchParams.getAll('keywords').length, 1);
    assert.equal(url.searchParams.get('geoId'), kind === 'jobs' ? '103644278' : null);
    assert.equal(url.searchParams.get('f_E'), kind === 'jobs' ? '1,2' : null);
  }
});

test('people and posts use recent hire/congratulations queries, not unsupported date filters', () => {
  const people = discoveryLinks({ kind: 'people', company: 'Acme', postedWithinDays: 14 });
  const posts = discoveryLinks({ kind: 'posts', company: 'Acme', postedWithinDays: 14 });
  assert.match(new URL(people.links[0].url).searchParams.get('keywords'), /recently joined|started a new position/);
  assert.match(new URL(posts.links[0].url).searchParams.get('keywords'), /congratulations|congrats/);
  assert.equal(new URL(people.links[0].url).pathname, '/search/results/people/');
  assert.equal(new URL(posts.links[0].url).pathname, '/search/results/content/');
  for (const result of [people, posts]) {
    const url = new URL(result.links[0].url);
    assert.deepEqual([...url.searchParams.keys()], ['keywords']);
    assert.match(result.notes.join(' '), /14-day window is not enforced/);
    assert.match(result.notes.join(' '), /manually|browser UI/);
    assert.equal(result.requiresBrowser, true);
    assert.equal(result.status, 'links_only');
  }
  assert.match(people.notes.join(' '), /no supported hire-date filter/);
  assert.match(posts.notes.join(' '), /not verified hires/);
});

test('recent hire discovery returns both browser searches; all adds job search', () => {
  for (const kind of ['recent_hires', 'hires']) {
    assert.equal(discoveryLinks({ kind }).links.length, 2);
  }
  const result = discoveryLinks({ kind: 'all', postedWithinDays: 3 });
  assert.equal(result.links.length, 3);
  assert.equal(new URL(result.links[0].url).searchParams.get('f_TPR'), 'r259200');
  assert.match(result.notes.join(' '), /not enforced for people\/posts/);
});

test('defaults include all roles, omit recency, and preserve input arrays', () => {
  const result = discoveryLinks();
  const url = new URL(result.links[0].url);
  assert.equal(url.searchParams.has('f_TPR'), false);
  for (const term of ['financial analyst', 'FP&A', 'investment banking', 'risk analyst']) {
    assert.ok(url.searchParams.get('keywords').includes(term));
  }
  const roles = ['risk', 'risk'];
  const filtered = new URL(discoveryLinks({ roles }).links[0].url).searchParams.get('keywords');
  assert.equal(filtered.match(/risk analyst/g).length, 1);
  assert.deepEqual(roles, ['risk', 'risk']);
});

test('discovery validates kinds, dates, and query text', () => {
  assert.throws(() => discoveryLinks({ kind: 'scrape' }), /kind/);
  for (const postedWithinDays of [null, 0, -1, 1.5, '7', 366, Infinity, NaN]) {
    assert.throws(() => discoveryLinks({ postedWithinDays }), /postedWithinDays/);
  }
  for (const company of [null, {}, 'a'.repeat(501), 'line\nbreak']) {
    assert.throws(() => discoveryLinks({ company }), /company/);
  }
  assert.throws(() => discoveryLinks({ keywords: [] }), /keywords/);
});

test('discovery and matching make no remote calls', t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
  assert.equal(discoveryLinks({ kind: 'all' }).links.length, 3);
  assert.equal(matchJob({ title: 'Risk Analyst', location: 'Remote' }).geography, 'unknown');
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
