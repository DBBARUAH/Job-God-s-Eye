# Job God's Eye — continuation checkpoint

## Goal
Build a free-first Claude MCP for a user with MS Finance and OPT seeking junior US jobs anywhere. Selectable roles: financial analyst, FP&A, investment banking, risk (all default). Find job-specific sponsorship evidence, relevant LinkedIn contacts/recent hires and congratulatory posts; draft networking messages and later truthful resume suggestions. User has not supplied a resume. STEM eligibility and OPT expiry are unknown.

Do not infer origin, ethnicity, nationality, or immigration status from names or indirect background. Use source-backed professional facts. Historical sponsorship, OPT acceptance, and future sponsorship are different. No automatic sending/applications. No credentials or personal job records belong in Git.

## Current implementation
Node >=22 ESM stdio MCP in `src/server.js` with thirteen tools: preferences, public Greenhouse/Lever boards, LinkedIn discovery links, observation intake/list/delete, drafting context, and four LinkedIn tools from `src/linkedin.js` (`linkedin_runtime_status`, `search_linkedin_jobs`, `read_linkedin_profile`, `read_linkedin_company_posts`). They call `python/bridge.py` through `src/python_bridge.js` (shell-free child, absolute interpreter, 4 MB response cap, per-mode timeouts, stderr discarded, whole process group killed after every call). `linkedin_research` prompt covers both the bridge tools and external browser tools. Host Claude drafts messages; no separate paid model API.

### Verification status (2026-10-02, macOS, Python 3.12.15, Node 23.6.1)
Offline fixture tests: `npm test` 89/89 (includes a real-bridge status/validation test that skips when `.venv` is missing); `python -m unittest discover -s python/tests` 32/32. Fixtures are synthetic, modelled on a real guest job page structure.

Live, separately: one `search_linkedin_jobs` call (financial_analyst, limit 3) returned status `ok`, 4 requests, 3 listings; 2 "Sr" titles were filtered out despite LinkedIn's entry-level filter, 1 kept (seniority `unknown`, sponsorship `unknown` because the description does not mention it). This proves the public guest path works; it says nothing about sponsored roles.

Bugs found by the review and live run, now fixed with regression tests: public job pages embed a hidden sign-in modal and a Google sign-in upsell, which the gate treated as an auth wall (sign-in markup now counts only when expected content is missing); `HTMLParser` was never closed, so titles ending in `&A` ("FP&A") came back empty; plain-text fields were HTML-parsed; the vendor plain-text converter leaked `<script>` text; malformed job IDs were labelled `blocked`; vendor `RateLimitError`/`AuthenticationError` became `network_error`; stray child output could corrupt stdout (fd 1 now reserved).

NOT verified live: `read_linkedin_profile` and `read_linkedin_company_posts` (need the user to sign in manually in the visible browser). Their selectors come from linkedin_scraper 3.1.2 and may be stale. Windows process-tree cleanup uses `taskkill /T` and is untested.

## Portable setup
```sh
npm ci
npm test
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# The bridge looks for browsers in .tools/browsers, so install them there:
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/browsers" .venv/bin/python -m playwright install chromium
.venv/bin/python -m unittest discover -s python/tests
# Windows: use .venv\Scripts\python and set PLAYWRIGHT_BROWSERS_PATH=%CD%\.tools\browsers
```
Use Python >=3.11 (the bridge uses `asyncio.timeout`), preferably 3.12. On macOS `brew install python@3.12`. Set FINANCE_JOB_PYTHON to an absolute interpreter path to override the `.venv` default. `requirements.txt` pins the two upstream Git revisions; transitive Python dependencies are not fully locked yet. Never disable TLS verification; use system trusted certificates if enterprise certificates require it. Original local runtimes, binaries, browser downloads and vendor clones are intentionally excluded from Git.

Upstreams:
- https://github.com/speedyapply/JobSpy at `83efd3d2ee7fce72d2b4cc4adb670f7e2b0e0e6b` (MIT)
- https://github.com/joeyism/linkedin_scraper at `b1cdc1c0e85bee8764d62565d229c682e5eb81bb` (Apache-2.0)

For source inspection clone these under ignored `vendor/` and check out the pinned revisions, or inspect installed package sources. Keep upstream licensing intact.

## Next steps
1. Live-test `read_linkedin_profile` and `read_linkedin_company_posts` with `interactiveLogin: true` only after the user agrees to sign in manually; record actual status. Fix selectors if `unrecognized_page`.
2. Create a machine-specific MCP configuration for the user's chosen Claude client after approval; none has been installed yet. Server command: `node /absolute/path/src/server.js`. Default saved records live in project `data/`; use FINANCE_JOB_DATA_DIR for another absolute path. Never commit generated config with personal machine paths.
3. Lock transitive Python dependencies (for example `pip-compile` / `uv pip compile`) so installs are reproducible.
4. Collect user inputs still unknown: resume, STEM designation, OPT expiry, graduation date.

## Handoff expectations
Continue implementation rather than restarting. User prefers direct execution of ordinary local setup/tests and authorized downloads, without repeated conversational permission questions. Respect tool-enforced permissions. Do not force-push or overwrite unrelated work. Report fixture tests separately from live verification and retain uncertainty about sponsorship.
