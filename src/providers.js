// Only public board APIs are fetched. Feed text remains untrusted plain text.
// Invalid records reject the whole board; limits reject rather than truncate.
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_JOBS = 2_000;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label}: expected a nonempty string`);
  }
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`Invalid ${label}: expected a string`);
  return value;
}

function jobId(value, provider) {
  if (provider === 'greenhouse' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  const id = requiredString(value, 'job id');
  const pattern = provider === 'greenhouse' ? /^[1-9]\d{0,127}$/ : /^[a-zA-Z0-9_-]{1,128}$/;
  if (!pattern.test(id)) throw new Error('Invalid job id');
  return id;
}

function jobUrl(value) {
  const raw = requiredString(value, 'job URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid job URL');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      /[\s\u0000-\u001f\u007f\\]/u.test(raw)) {
    throw new Error('Invalid job URL: expected an absolute HTTPS URL without credentials');
  }
  return url.href;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
};

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match;
    const hex = entity[1].toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : '\ufffd';
  });
}

function plainText(value) {
  // Greenhouse can entity-encode its HTML. Decode before stripping so encoded
  // markup is not reintroduced afterward. This is NOT an HTML sanitizer: callers
  // must render the result with textContent, never innerHTML.
  let text = value;
  for (let pass = 0; pass < 2; pass += 1) text = decodeEntities(text);
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function greenhouseJob(raw, identifier) {
  record(raw, 'Greenhouse job');
  if (raw.location != null) record(raw.location, 'Greenhouse location');
  return {
    provider: 'greenhouse',
    externalId: jobId(raw.id, 'greenhouse'),
    title: requiredString(raw.title, 'job title'),
    company: optionalString(raw.company_name, 'company name').trim() || identifier,
    location: optionalString(raw.location?.name, 'location').trim(),
    url: jobUrl(raw.absolute_url),
    text: plainText(optionalString(raw.content, 'description')),
    // updated_at is an edit timestamp, NOT evidence of the posting date.
    publishedAt: null,
  };
}

function leverJob(raw, identifier) {
  record(raw, 'Lever job');
  if (raw.categories != null) record(raw.categories, 'Lever categories');
  const parts = [optionalString(raw.descriptionPlain ?? raw.description, 'description')];
  if (raw.lists != null) {
    if (!Array.isArray(raw.lists)) throw new Error('Invalid Lever description lists');
    for (const list of raw.lists) {
      record(list, 'Lever description list');
      parts.push(optionalString(list.text, 'list title'), optionalString(list.content, 'list content'));
    }
  }
  parts.push(optionalString(raw.additionalPlain ?? raw.additional, 'additional description'));
  let publishedAt = null;
  if (raw.createdAt != null) {
    if (!Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0 ||
        !Number.isFinite(new Date(raw.createdAt).getTime())) {
      throw new Error('Invalid Lever createdAt');
    }
    publishedAt = new Date(raw.createdAt).toISOString();
  }
  return {
    provider: 'lever',
    externalId: jobId(raw.id, 'lever'),
    title: requiredString(raw.text, 'job title'),
    company: identifier,
    location: optionalString(raw.categories?.location, 'location').trim(),
    url: jobUrl(raw.hostedUrl),
    text: plainText(parts.join('\n')),
    publishedAt,
  };
}

async function readJson(response, signal, budget) {
  const contentType = response.headers.get('content-type');
  if (contentType && !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
    throw new Error('Invalid feed content type: expected JSON');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES ||
      Number(declared) + budget.bytes > MAX_TOTAL_BYTES)) {
    throw new Error('Feed body byte limit exceeded or invalid content length');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Invalid feed: missing readable body');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid feed byte stream');
      bytes += value.byteLength;
      budget.bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES || budget.bytes > MAX_TOTAL_BYTES) {
        throw new Error('Feed body byte limit exceeded');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Invalid feed JSON');
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function fetchBoard({ provider, identifier }, { fetchImpl = fetch } = {}) {
  if (provider !== 'greenhouse' && provider !== 'lever') {
    throw new Error('Unsupported provider: use greenhouse or lever');
  }
  // Slugs only: no URLs, path separators, query strings, dots or percent escapes.
  if (typeof identifier !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(identifier)) {
    throw new Error('Invalid board identifier');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Board fetch timed out');
      controller.abort(error);
      reject(error);
    }, TIMEOUT_MS);
  });
  const budget = { bytes: 0 };
  const jobs = [];
  const seen = new Set();
  async function get(url) {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    try {
      controller.signal.throwIfAborted();
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new Error('Provider redirect rejected');
      }
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      return await readJson(response, controller.signal, budget);
    } catch (error) {
      if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
      throw error;
    }
  }
  function add(rawJobs, normalize) {
    if (jobs.length + rawJobs.length > MAX_JOBS) throw new Error('Feed job limit exceeded');
    for (const raw of rawJobs) {
      const job = normalize(raw, identifier);
      // Duplicates make pagination ambiguous; fail rather than silently lose jobs.
      if (seen.has(job.externalId)) throw new Error(`Duplicate job id: ${job.externalId}`);
      seen.add(job.externalId);
      jobs.push(job);
    }
  }
  async function load() {
    if (provider === 'greenhouse') {
      const feed = record(await get(
        `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs?content=true`,
      ), 'Greenhouse feed');
      if (!Array.isArray(feed.jobs)) throw new Error('Invalid Greenhouse jobs array');
      if (feed.meta != null) {
        record(feed.meta, 'Greenhouse metadata');
        if (!Number.isSafeInteger(feed.meta.total) || feed.meta.total !== feed.jobs.length) {
          throw new Error('Invalid or incomplete Greenhouse total');
        }
      }
      add(feed.jobs, greenhouseJob);
    } else {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const feed = await get(`https://api.lever.co/v0/postings/${identifier}?mode=json&limit=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`);
        if (!Array.isArray(feed)) throw new Error('Invalid Lever jobs array');
        if (feed.length > PAGE_SIZE) throw new Error('Lever page size limit exceeded');
        add(feed, leverJob);
        if (feed.length < PAGE_SIZE) break;
        if (page === MAX_PAGES - 1) throw new Error('Lever pagination limit exceeded');
      }
    }
    const fetchedAt = new Date().toISOString();
    return { jobs: jobs.map(job => ({ ...job, observedAt: fetchedAt })), fetchedAt };
  }
  try {
    return await Promise.race([load(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
