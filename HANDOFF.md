# Job God's Eye — continuation checkpoint

## Goal
Build a free-first Claude MCP for a user with MS Finance and OPT seeking junior US jobs anywhere. Selectable roles: financial analyst, FP&A, investment banking, risk (all default). Find job-specific sponsorship evidence, relevant LinkedIn contacts/recent hires and congratulatory posts; draft networking messages and later truthful resume suggestions. User has not supplied a resume. STEM eligibility and OPT expiry are unknown.

Do not infer origin, ethnicity, nationality, or immigration status from names or indirect background. Use source-backed professional facts. Historical sponsorship, OPT acceptance, and future sponsorship are different. No automatic sending/applications. No credentials or personal job records belong in Git.

## Current implementation
Node >=22 ESM stdio MCP in `src/server.js` with nine tools: preferences, public Greenhouse/Lever boards, LinkedIn discovery links, observation intake/list/delete and drafting context. `linkedin_research` prompt coordinates external browser tools. LinkedIn links alone are not retrieved results. Host Claude drafts messages; no separate paid model API.

The original 72 Node tests passed. Public Greenhouse feed retrieval returned 20 listings on 2026-10-02; this was connectivity testing, not evidence of suitable sponsored finance roles. Chromium download and Chrome extension were unavailable on the original laptop. No live LinkedIn search/profile test has succeeded.

`python/bridge.py` is an interrupted integration draft. It is NOT registered in the MCP and has not received its intended unit/integration tests or full review. No `src/python_bridge.js`, `src/linkedin.js`, or Python test suite was finished. Do not treat this as a complete LinkedIn integration.

## Portable setup
```sh
npm ci
npm test
python -m venv .venv
# Windows:
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m playwright install chromium
# macOS/Linux equivalents use .venv/bin/python
```
Use Python >=3.10, preferably 3.12. `requirements.txt` pins the two upstream Git revisions; transitive Python dependencies are not fully locked yet. Never disable TLS verification; use system trusted certificates if enterprise certificates require it. Original local runtimes, binaries, browser downloads and vendor clones are intentionally excluded from Git.

Upstreams:
- https://github.com/speedyapply/JobSpy at `83efd3d2ee7fce72d2b4cc4adb670f7e2b0e0e6b` (MIT)
- https://github.com/joeyism/linkedin_scraper at `b1cdc1c0e85bee8764d62565d229c682e5eb81bb` (Apache-2.0)

For source inspection clone these under ignored `vendor/` and check out the pinned revisions, or inspect installed package sources. Keep upstream licensing intact.

## Next implementation steps
1. Review `python/bridge.py` against actual pinned vendor APIs. JobSpy LinkedIn uses the public guest jobs endpoint and `/jobs/view/{id}`; upstream catches errors and returns partial/empty results. Preserve explicit blocked/rate-limit/network/unrecognized-page states rather than converting failures to no matches. `is_tls=False` in JobSpy selects requests instead of curl_cffi; it does NOT itself disable certificate verification.
2. Finish the Python bridge and tests: JSON stdin/stdout, bounded request/response, max20 job results, timeouts, allowed LinkedIn paths, no proxies/stealth/impersonation/cookie collection, no retries around access blocks. Ordinary requests with TLS verification and no following unvalidated redirects. Normalize title/company/location/url/text/date; no emails in output.
3. Complete `src/python_bridge.js`: shell-free child process with absolute Python executable configurable via FINANCE_JOB_PYTHON, platform-specific `.venv` default, fixed script path, JSON request, response cap, subprocess timeout/cleanup and structured errors. Ensure browser child processes close too. Avoid accidentally requiring the old laptop's paths.
4. Add `src/linkedin.js` tools and register from server.js: `linkedin_runtime_status`, `search_linkedin_jobs` (role filters, US default, capped count and recency), `read_linkedin_profile`, `read_linkedin_company_posts` (single validated LinkedIn URL, posts max5). Use existing `matchJob` and `sponsorshipEvidence`. Do not automatically persist collected personal records.
5. Profile/company posts: normal Playwright visible browser, manual user login only when explicitly requested, ephemeral session, no secrets in tool args/results/storage. Avoid vendor BrowserManager stealth/warm-up behavior and full-profile extraction of contacts/connections. Stop on CAPTCHA/access restriction/rate limit. These are direct-URL reads; general post/people discovery still uses search/browser workflow.
6. Add Python vendor-parser fixtures and Node bridge/MCP tests (including malformed JSON, subprocess errors, timeout/size caps, invalid URLs, auth_required/blocked and partial result states). Update expected tool names and workflow prompt. Keep npm test scoped to `test/*.test.js` rather than executing cloned vendor tests.
7. Run all offline tests, then one live public LinkedIn search with limit3. Report actual source/count/status; stop on access blocking. Test a profile/company page only after user manually logs in. Clearly label any unverified features.
8. Create a machine-specific MCP configuration for the user's chosen Claude client after approval; none has been installed yet. `node /absolute/path/src/server.js` is the server command. Default saved records live in project `data/`; use FINANCE_JOB_DATA_DIR for another absolute path. Never commit generated config with personal machine paths.

## Handoff expectations
Continue implementation rather than restarting. User prefers direct execution of ordinary local setup/tests and authorized downloads, without repeated conversational permission questions. Respect tool-enforced permissions. Do not force-push or overwrite unrelated work. Report fixture tests separately from live verification and retain uncertainty about sponsorship.
