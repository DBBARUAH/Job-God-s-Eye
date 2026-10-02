export const ROLES = Object.freeze([
  'financial_analyst', 'fp_and_a', 'investment_banking', 'risk',
]);

export const DEFAULT_PREFERENCES = Object.freeze({
  roles: ROLES,
  geography: 'US',
  seniority: 'junior',
  degree: 'MS Finance',
  workAuthorization: 'OPT',
  graduationDate: null,
  stemDesignated: null,
  optExpiry: null,
});

const ROLE_PATTERNS = {
  financial_analyst: /\b(?:financial|finance)\s+analyst\b/i,
  fp_and_a: /\bfp\s*(?:&|and)\s*a\b|\bfinancial planning\s*(?:&|and)\s*analysis\b/i,
  investment_banking: /\binvestment bank(?:ing|er)\b/i,
  risk: /\b(?:risk\s+(?:analyst|analysis|associate|manager|management|officer|specialist)|(?:credit|market|financial|liquidity|investment|enterprise|operational|quantitative)\s+risk)\b/i,
};

const US_COUNTRY = /\b(?:united states(?: of america)?|usa)\b|\bU\.S\.(?:A\.?)?(?=\W|$)|\bUS\b/i;
const OUTSIDE_COUNTRY = /\b(?:canada|united kingdom|uk|england|ireland|germany|france|india|singapore|australia|china|japan|mexico|brazil|netherlands|switzerland|spain|italy|poland|sweden|hong kong|united arab emirates|uae|south africa|new zealand)\b/i;
const GLOBAL = /\b(?:worldwide|global|anywhere|everywhere|multiple countries)\b/i;
const STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
// Require a city plus an uppercase postal state code, not an isolated ambiguous
// abbreviation such as CA (Canada), IN (India), or a word containing "US".
const CITY_STATE = new RegExp(`(?:^|[;|/])\\s*[A-Za-z][A-Za-z .'-]*,\\s*(?:${STATES})(?=\\s*(?:\\d{5}(?:-\\d{4})?)?(?:$|[,;(]))`);
const US_STATE_NAME = /\b(?:california|massachusetts|pennsylvania|texas|florida|illinois|new jersey|north carolina|south carolina|connecticut|colorado|virginia|wisconsin|michigan|maryland|ohio|oregon|arizona|tennessee|utah|minnesota|nevada)\b/i;

function geographyOf(location) {
  if (!location || GLOBAL.test(location) ||
      /\b(?:outside|excluding|except|not|non)[ -]*(?:the\s+)?(?:US\b|USA\b|U\.S\.|united states\b)/i.test(location)) {
    return 'unknown';
  }
  const us = US_COUNTRY.test(location) || CITY_STATE.test(location) || US_STATE_NAME.test(location);
  const outside = OUTSIDE_COUNTRY.test(location);
  if (us && outside) return 'unknown';
  if (us) return 'US';
  if (outside) return 'outside_US';
  return 'unknown';
}

function seniorityOf(title) {
  if (/\b(?:senior|sr\.?|lead|principal|staff|manager|director|head|chief|vp|vice president|executive)\b|\b(?:ii|iii|iv)\b/i.test(title)) {
    return 'senior';
  }
  if (/\b(?:junior|jr\.?|entry[ -]level|intern(?:ship)?|graduate|new grad|trainee)\b|\banalyst\s+(?:i|1)\b/i.test(title)) {
    return 'junior';
  }
  // "Analyst" and "associate" alone do not establish years of experience.
  return 'unknown';
}

export function matchJob(job, roles = ROLES) {
  if (!Array.isArray(roles) || roles.some(role => !ROLES.includes(role))) {
    throw new TypeError('roles must be an array of supported role names');
  }
  const title = typeof job?.title === 'string' ? job.title : '';
  const location = typeof job?.location === 'string' ? job.location : '';
  return {
    // Description boilerplate, equal-opportunity text, and benefits are not
    // evidence of the job's role, location, or seniority.
    roles: [...new Set(roles)].filter(role => ROLE_PATTERNS[role].test(title)),
    geography: geographyOf(location),
    seniority: seniorityOf(title),
  };
}
