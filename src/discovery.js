import { ROLES } from './preferences.js';

const ROLE_QUERIES = {
  financial_analyst: '"financial analyst"',
  fp_and_a: '("FP&A" OR "financial planning and analysis")',
  investment_banking: '"investment banking"',
  risk: '("risk analyst" OR "risk management")',
};

function queryText(value, name) {
  if (typeof value !== 'string' || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be a string of at most 500 characters without control characters`);
  }
  return value.trim();
}

function linkedInUrl(path, params) {
  const url = new URL(path, 'https://www.linkedin.com');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

export function discoveryLinks({ kind = 'jobs', roles = ROLES, company = '', keywords = '', postedWithinDays } = {}) {
  if (!['jobs', 'people', 'posts', 'recent_hires', 'hires', 'all'].includes(kind)) {
    throw new TypeError('kind must be jobs, people, posts, recent_hires, hires, or all');
  }
  if (!Array.isArray(roles) || roles.some(role => !ROLES.includes(role))) {
    throw new TypeError('roles must be an array of supported role names');
  }
  if (postedWithinDays !== undefined && (!Number.isInteger(postedWithinDays) ||
      postedWithinDays < 1 || postedWithinDays > 365)) {
    throw new TypeError('postedWithinDays must be an integer from 1 to 365');
  }
  const selected = [...new Set(roles)];
  const terms = selected.map(role => ROLE_QUERIES[role]);
  const query = [terms.length ? `(${terms.join(' OR ')})` : '',
    queryText(company, 'company'), queryText(keywords, 'keywords')].filter(Boolean).join(' ');
  const links = [];
  const notes = [];
  if (kind === 'jobs' || kind === 'all') {
    const params = { keywords: query, location: 'United States', geoId: '103644278', f_E: '1,2' };
    if (postedWithinDays !== undefined) params.f_TPR = `r${postedWithinDays * 86400}`;
    links.push({ label: 'LinkedIn jobs — United States, internship / entry level',
      url: linkedInUrl('/jobs/search/', params) });
    notes.push('Job filters request United States and internship / entry-level results; verify each listing. They do not confirm work authorization or sponsorship.');
  }
  const hires = kind === 'recent_hires' || kind === 'hires' || kind === 'all';
  if (kind === 'people' || hires) {
    links.push({ label: 'LinkedIn people — recent hire discovery',
      url: linkedInUrl('/search/results/people/', {
        keywords: [query, '("recently joined" OR "new role" OR "started a new position")'].filter(Boolean).join(' '),
      }) });
    notes.push('LinkedIn people search has no supported hire-date filter; keyword matches do not establish when someone was hired. Review results manually.');
  }
  if (kind === 'posts' || hires) {
    links.push({ label: 'LinkedIn posts — new roles and congratulations',
      url: linkedInUrl('/search/results/content/', {
        keywords: [query, '("congratulations" OR "congrats" OR "happy to share" OR "started a new position")'].filter(Boolean).join(' '),
      }) });
    notes.push('Posts are keyword searches, not verified hires. Apply available date filters in the LinkedIn browser UI; arbitrary date windows are not encoded for posts.');
  }
  if (postedWithinDays !== undefined && (kind !== 'jobs')) {
    notes.push(`The requested ${postedWithinDays}-day window is not enforced for people/posts; verify dates manually.`);
  }
  notes.push('Links only: no profiles, posts, or job search results have been fetched. LinkedIn may require sign-in.');
  return { links, notes, status: 'links_only', requiresBrowser: true };
}
