"""Single-request JSON bridge. Network access is opt-in and never bypasses gates."""
from __future__ import annotations

import asyncio
from contextlib import redirect_stdout, suppress
from datetime import date, datetime, timezone
from html import unescape
from html.parser import HTMLParser
import importlib
import importlib.metadata
import io
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

MAX_INPUT = 64 * 1024
MAX_BODY = 2 * 1024 * 1024
REQUEST_TIMEOUT = 15
LOGIN_TIMEOUT = 120
PROJECT = Path(__file__).resolve().parent.parent
SEARCH_PATH = "/jobs-guest/jobs/api/seeMoreJobPostings/search"
JOB_URL = re.compile(r"https://www\.linkedin\.com/jobs/view/[0-9]+\Z")
CHALLENGE_PATH = re.compile(r"/(?:checkpoint|challenge|captcha|authwall)(?:/|$)", re.I)
AUTH_PATH = re.compile(r"/(?:login|uas/login|signup)(?:/|$)", re.I)
CHALLENGE_SELECTOR = (
    'iframe[src*="captcha"], iframe[src*="challenge"], '
    '#captcha, #challenge, #checkpoint, form[action*="checkpoint"], '
    'input[name="pin"], input[autocomplete="one-time-code"]'
)
AUTH_SELECTOR = 'input[type="password"], form[action*="login"], .authwall'
SEARCH_CONTENT = "div.base-search-card"
DETAIL_CONTENT = "div.show-more-less-html__markup"
# Public job pages embed a hidden contextual sign-in modal; it is not a gate.
INERT_SELECTOR = '[hidden], .hidden, [aria-hidden="true"], [class*="sign-in-modal"], template, noscript'


class BridgeError(Exception):
    def __init__(self, status: str, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "iframe", "object"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "iframe", "object"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def clean_text(value, maximum=12000, html=False) -> str:
    """Normalize vendor text. Only descriptions are HTML; titles, names and post
    text are already plain, so parsing them as HTML would drop literal '<'."""
    if not isinstance(value, str):
        return ""
    if html:
        parser = TextParser()
        parser.feed(unescape(unescape(value)))
        parser.close()  # Flush text buffered after a trailing '&' (e.g. "FP&A").
        text = " ".join(parser.parts)
    else:
        text = value
    # Remove whole email-bearing tokens, including Unicode addresses and mailto URLs.
    text = re.sub(r"\S*@\S*", "[redacted]", text)
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    return " ".join(text.split())[:maximum]


def integer(value, name, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        raise BridgeError("invalid_request", f"invalid_{name}")
    return value


def string(value, name, maximum=300):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise BridgeError("invalid_request", f"invalid_{name}")
    if re.search(r"[\x00-\x1f\x7f]", value):
        raise BridgeError("invalid_request", f"invalid_{name}")
    return value.strip()


def exact_url(value, mode):
    kind = "in" if mode == "profile" else "company"
    if not isinstance(value, str) or not re.fullmatch(
        rf"https://www\.linkedin\.com/{kind}/[A-Za-z0-9][A-Za-z0-9_-]{{0,99}}/?", value
    ):
        raise BridgeError("invalid_request", "invalid_linkedin_url")
    return value.rstrip("/") + "/"


def validate(payload):
    if not isinstance(payload, dict) or set(payload) - {"mode", "args"}:
        raise BridgeError("invalid_request", "expected_mode_and_args")
    mode = payload.get("mode")
    if mode not in ("status", "jobs", "profile", "company_posts"):
        raise BridgeError("invalid_request", "invalid_mode")
    args = payload.get("args", {})
    if not isinstance(args, dict):
        raise BridgeError("invalid_request", "invalid_args")
    if mode == "status":
        if args:
            raise BridgeError("invalid_request", "unexpected_args")
        return mode, {}
    if mode == "jobs":
        if set(args) - {"searchTerm", "location", "limit", "hoursOld"}:
            raise BridgeError("invalid_request", "unexpected_args")
        result = {
            "searchTerm": string(args.get("searchTerm"), "searchTerm"),
            "location": string(args.get("location", "United States"), "location"),
            "limit": integer(args.get("limit", 10), "limit", 1, 20),
        }
        if args.get("hoursOld") is not None:
            result["hoursOld"] = integer(args["hoursOld"], "hoursOld", 1, 87600)
        return mode, result
    if set(args) - {"url", "limit", "interactiveLogin"}:
        raise BridgeError("invalid_request", "unexpected_args")
    interactive = args.get("interactiveLogin", False)
    if type(interactive) is not bool:
        raise BridgeError("invalid_request", "invalid_interactiveLogin")
    return mode, {
        "url": exact_url(args.get("url"), mode),
        "limit": integer(args.get("limit", 5), "limit", 1, 5),
        "interactiveLogin": interactive,
    }


def html_gate(html, url="", allow_login=False, content_selector=None):
    """Check visible gate markup, not incidental sign-in links in public pages.

    Public guest pages carry sign-in modals and upsell forms beside real content.
    With content_selector, sign-in markup is a gate only when that content is absent.
    """
    from bs4 import BeautifulSoup

    path = urlsplit(url).path
    if CHALLENGE_PATH.search(path):
        return "blocked"
    soup = BeautifulSoup(html, "html.parser")
    if soup.select_one(CHALLENGE_SELECTOR):
        return "blocked"
    has_content = bool(content_selector and soup.select_one(content_selector))
    # Restrict detection to visible markup; script bundles often mention captcha.
    for tag in soup(["script", "style"]):
        tag.decompose()
    for tag in soup.select(INERT_SELECTOR):
        tag.decompose()
    visible = soup.get_text(" ", strip=True).lower()
    if any(s in visible for s in ("too many requests", "rate limit exceeded")):
        return "rate_limited"
    if any(s in visible for s in (
        "verify you are human", "verify you're human", "security verification",
        "complete the captcha", "unusual activity", "your account has been restricted",
    )):
        return "blocked"
    if allow_login:
        return None
    if AUTH_PATH.search(path):
        return "blocked"
    if soup.select_one(AUTH_SELECTOR) and not has_content:
        return "blocked"
    return None


class GuardedSession:
    """An ordinary requests Session behind a fail-closed transport boundary.

    The vendor catches transport exceptions, including detail errors. Keep failure
    state here so an empty response cannot be misrepresented as a successful search.
    """

    def __init__(self, limit):
        try:
            import truststore
        except ImportError:
            pass
        else:
            truststore.inject_into_ssl()
        import requests
        from http.cookiejar import DefaultCookiePolicy

        class NoCookies(DefaultCookiePolicy):
            def set_ok(self, cookie, request):
                return False

            def return_ok(self, cookie, request):
                return False

        self.session = requests.Session()
        self.session.trust_env = False
        self.session.verify = True
        self.session.proxies.clear()
        self.session.auth = None
        self.session.cookies.set_policy(NoCookies())
        self.session.headers.clear()
        self.session.headers.update({
            "User-Agent": "finance-job-search/1.0 (public guest jobs)",
            "Accept": "text/html", "Accept-Encoding": "identity",
        })
        for adapter in self.session.adapters.values():
            adapter.max_retries = requests.adapters.Retry(total=0, redirect=0)
        self.budget = limit + 2
        self.requests = 0
        self.failures = []
        self.stopped = False
        self.cards_seen = 0
        self.empty_search = False

    def fail(self, status, reason):
        self.failures.append({"status": status, "reason": reason})
        self.stopped = True
        raise BridgeError(status, reason)

    def close(self):
        self.session.cookies.clear()
        self.session.close()

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def request(self, method, url, **kwargs):
        import requests
        from bs4 import BeautifulSoup

        if self.stopped:
            failure = self.failures[-1]
            raise BridgeError(failure["status"], failure["reason"])
        # Raw spelling matters: no credentials, ports, percent escapes or dot paths.
        if method.upper() != "GET" or not isinstance(url, str):
            self.fail("blocked", "request_not_allowed")
        search = url in ("https://www.linkedin.com" + SEARCH_PATH,
                         "https://www.linkedin.com" + SEARCH_PATH + "?")
        if not search and not JOB_URL.fullmatch(url):
            # The vendor builds detail URLs from card hrefs; a non-numeric ID means
            # LinkedIn markup changed, not that access was blocked.
            if re.fullmatch(r"https://www\.linkedin\.com/jobs/view/[A-Za-z0-9_-]{1,200}", url):
                self.fail("unrecognized_page", "job_id_unrecognized")
            self.fail("blocked", "url_not_allowed")
        if self.requests >= self.budget:
            self.fail("limit_reached", "request_budget_exceeded")
        if set(kwargs) - {"params", "allow_redirects", "timeout", "stream"}:
            self.fail("blocked", "request_options_not_allowed")
        params = kwargs.get("params") or {}
        if not isinstance(params, dict) or (not search and params):
            self.fail("blocked", "request_params_not_allowed")
        params = dict(params)
        if search:
            params["f_E"] = "2"  # LinkedIn entry-level filter; vendor lacks this option.
        self.requests += 1
        self.session.cookies.clear()
        started = time.monotonic()
        response = None
        try:
            # Explicitly overwrite get()'s allow_redirects, never pass it twice.
            response = self.session.request(
                "GET", url, params=params, allow_redirects=False,
                timeout=REQUEST_TIMEOUT, stream=True, verify=True, proxies={},
            )
            code = response.status_code
            if code == 429:
                self.fail("rate_limited", "http_429")
            if code in (401, 403, 407, 999) or 300 <= code < 400:
                self.fail("blocked", "redirect_rejected" if 300 <= code < 400 else f"http_{code}")
            if code != 200:
                self.fail("network_error", f"http_{code}")
            if response.url and response.url.split("?", 1)[0] != url.rstrip("?"):
                self.fail("blocked", "unexpected_response_url")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type and content_type not in ("text/html", "application/xhtml+xml"):
                self.fail("unrecognized_page", "unexpected_content_type")
            declared = response.headers.get("Content-Length")
            if declared is not None and (not declared.isdecimal() or int(declared) > MAX_BODY):
                self.fail("unrecognized_page", "body_limit_exceeded")
            data = bytearray()
            for chunk in response.iter_content(chunk_size=16384):
                if time.monotonic() - started > REQUEST_TIMEOUT:
                    self.fail("network_error", "request_timeout")
                if len(data) + len(chunk) > MAX_BODY:
                    self.fail("unrecognized_page", "body_limit_exceeded")
                data.extend(chunk)
            html = bytes(data).decode("utf-8", errors="replace")
            gate = html_gate(html, response.url or url,
                             content_selector=SEARCH_CONTENT if search else DETAIL_CONTENT)
            if gate:
                self.fail(gate, "access_gate")
            soup = BeautifulSoup(html, "html.parser")
            if search:
                cards = soup.select(SEARCH_CONTENT)
                self.cards_seen += len(cards)
                if not cards:
                    # Empty guest fragments are LinkedIn's end-of-results response.
                    # A nonempty changed page is NOT evidence of zero matching jobs.
                    if not html.strip() or soup.select_one(".jobs-search-no-results-banner"):
                        self.empty_search = True
                    else:
                        self.fail("unrecognized_page", "search_markup_changed")
                elif any(not card.select_one("a.base-card__full-link[href]") or
                         not card.select_one("span.sr-only") for card in cards):
                    self.fail("unrecognized_page", "job_card_markup_changed")
            elif not soup.select_one(DETAIL_CONTENT):
                self.fail("unrecognized_page", "description_markup_missing")
            # A bounded, detached Response keeps the actual vendor parser unchanged.
            result = requests.Response()
            result.status_code = code
            result.url = response.url or url
            result.headers = response.headers.copy()
            result.encoding = "utf-8"
            result._content = bytes(data)
            return result
        except BridgeError:
            raise
        except requests.exceptions.RequestException:
            self.fail("network_error", "request_failed")
        except (OSError, ValueError):
            self.fail("network_error", "response_read_failed")
        finally:
            self.session.cookies.clear()
            if response is not None:
                response.close()


def normalize_job(job, observed):
    url = getattr(job, "job_url", "")
    if not isinstance(url, str) or not JOB_URL.fullmatch(url):
        return None
    title = clean_text(getattr(job, "title", ""), 500)
    if not title or title == "N/A":
        return None
    location = getattr(job, "location", None)
    text = clean_text(getattr(job, "description", None), html=True)
    published = getattr(job, "date_posted", None)
    return {
        "title": title,
        "company": clean_text(getattr(job, "company_name", ""), 500),
        "location": clean_text(location.display_location() if location else "", 500),
        "url": url,
        "text": text,
        # The guest card carries a calendar date only; the vendor stores midnight.
        "publishedAt": (published.date() if isinstance(published, datetime) else published).isoformat()
        if isinstance(published, date) else None,
        "observedAt": observed,
        "descriptionAvailable": bool(text),
    }


def jobs(args):
    from jobspy.linkedin import LinkedIn
    from jobspy.model import DescriptionFormat, ScraperInput, Site

    guarded = GuardedSession(args["limit"])
    try:
        scraper = LinkedIn()
        scraper.session.close()
        scraper.session = guarded
        # No retries or gratuitous vendor pagination sleeps. The guard bounds requests.
        scraper.delay = scraper.band_delay = 0
        scraper_input = ScraperInput(
            site_type=[Site.LINKEDIN], search_term=args["searchTerm"],
            location=args["location"], results_wanted=args["limit"],
            hours_old=args.get("hoursOld"), fetch_description=True,
            # HTML, not PLAIN: the vendor's plain converter keeps <script> text.
            # clean_text drops hidden elements and redacts emails itself.
            description_format=DescriptionFormat.HTML,
        )
        try:
            response = scraper.scrape(scraper_input)
            raw = response.jobs
        except Exception:
            raw = []
            if not guarded.failures:
                guarded.failures.append({"status": "unrecognized_page", "reason": "vendor_parser_failed"})
        observed = now()
        normalized = []
        seen = set()
        for job in raw:
            item = normalize_job(job, observed)
            if item and item["url"] not in seen:
                normalized.append(item)
                seen.add(item["url"])
        failures = list(guarded.failures)
        if len(normalized) != len(raw) or (not normalized and guarded.cards_seen and not failures):
            failures.append({"status": "unrecognized_page", "reason": "job_parser_incomplete"})
        if normalized:
            status = "partial" if failures or any(not j["descriptionAvailable"] for j in normalized) else "ok"
        elif failures:
            status = failures[0]["status"]
        else:
            status = "no_results" if guarded.empty_search else "unrecognized_page"
        return {"status": status, "jobs": normalized[:args["limit"]],
                "failures": failures, "requestCount": guarded.requests,
                "observedAt": observed}
    finally:
        guarded.close()


def profile_facts(person, headline=None, limit=5):
    """Explicit allowlist: never dump a vendor model or include freeform about text."""
    def facts(items, fields):
        return [{out: clean_text(getattr(item, source, None), 500) or None
                 for out, source in fields.items()} for item in list(items or [])[:limit]]

    return {
        "name": clean_text(getattr(person, "name", None), 300) or None,
        "headline": clean_text(headline, 500) or None,
        "work": facts(getattr(person, "experiences", []), {
            "title": "position_title", "company": "institution_name",
            "from": "from_date", "to": "to_date",
        }),
        "education": facts(getattr(person, "educations", []), {
            "institution": "institution_name", "degree": "degree",
            "from": "from_date", "to": "to_date",
        }),
    }


def post_facts(posts, limit=5):
    result = []
    for post in posts[:limit]:
        text = clean_text(getattr(post, "text", None))
        source = getattr(post, "linkedin_url", None)
        if not isinstance(source, str) or not re.fullmatch(
            r"https://www\.linkedin\.com/feed/update/urn:li:activity:[0-9]+/?", source
        ):
            source = None
        if text:
            # Vendor dates are relative/ambiguous ("3d", "2w"). Report the label as
            # observed and do not manufacture a timestamp from it.
            relative = clean_text(getattr(post, "posted_date", None), 40)
            result.append({"text": text, "source": source, "publishedAt": None,
                           "relativeAge": relative if re.fullmatch(r"\d+\s*[hdwmy]", relative) else None})
    return result


async def page_gate(page, allow_login=False):
    gate = html_gate(await page.content(), page.url, allow_login=allow_login)
    if gate:
        raise BridgeError(gate, "browser_access_gate")


async def wait_for_manual_login(page):
    async with asyncio.timeout(LOGIN_TIMEOUT):
        await page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded", timeout=15000)
        while True:
            await page_gate(page, allow_login=True)
            path = urlsplit(page.url).path
            # Positive authenticated UI evidence, not simply a URL change.
            if not AUTH_PATH.search(path) and await page.locator(
                'nav.global-nav, #global-nav, a[data-test-global-nav-link="feed"]'
            ).count():
                return
            await asyncio.sleep(0.25)


async def scrape_current_page(mode, page, args):
    """Use vendor parsers without contact harvesting or BrowserManager behavior."""
    from linkedin_scraper.scrapers.person import PersonScraper
    from linkedin_scraper.scrapers.company_posts import CompanyPostsScraper
    from linkedin_scraper.models.person import Person

    await page.goto(args["url"], wait_until="domcontentloaded", timeout=15000)
    await page_gate(page)
    if mode == "profile":
        scraper = PersonScraper(page)
        # These vendor helpers fall back to details pages. Restrict fallback to just
        # this profile's professional sections and check gates after each navigation.
        async def navigate(url, **kwargs):
            if url not in (args["url"] + "details/experience", args["url"] + "details/education"):
                raise BridgeError("blocked", "profile_navigation_not_allowed")
            await page_gate(page)
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await page_gate(page)

        scraper.navigate_and_wait = navigate
        name = await scraper.safe_extract_text("main h1", default="")
        headline = await scraper.safe_extract_text("main .text-body-medium.break-words", default="")
        work = await scraper._get_experiences(args["url"])
        await page_gate(page)
        # Return to the target before extracting education if experience used fallback.
        if page.url.rstrip("/") != args["url"].rstrip("/"):
            await page.goto(args["url"], wait_until="domcontentloaded", timeout=15000)
            await page_gate(page)
        education = await scraper._get_educations(args["url"])
        await page_gate(page)
        person = Person(linkedin_url=args["url"], name=name, experiences=work, educations=education)
        facts = profile_facts(person, headline, args["limit"])
        return {"status": "ok" if facts["name"] else "unrecognized_page", "profile": facts}
    scraper = CompanyPostsScraper(page)

    async def navigate_posts(url, **kwargs):
        if url != args["url"].rstrip("/") + "/posts/":
            raise BridgeError("blocked", "posts_navigation_not_allowed")
        await page_gate(page)
        await page.goto(url, wait_until="domcontentloaded", timeout=15000)
        await page_gate(page)

    scraper.navigate_and_wait = navigate_posts
    posts = post_facts(await scraper.scrape(args["url"], limit=args["limit"]), args["limit"])
    await page_gate(page)
    return {"status": "ok" if posts else "unrecognized_page", "posts": posts}


async def browser_operation(mode, args):
    from playwright.async_api import async_playwright

    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(PROJECT / ".tools" / "browsers"))
    browser = context = None
    monitor = operation = None
    blocked = asyncio.Event()
    gate_status = "blocked"
    try:
        async with async_playwright() as playwright:
            try:
                # Plain, headful, nonpersistent Playwright: no stealth, saved state,
                # custom UA, vendor browser manager, warm-up, or credential loading.
                browser = await playwright.chromium.launch(headless=False)
                context = await browser.new_context(service_workers="block")
                page = await context.new_page()
                page.set_default_timeout(15000)

                async def route_request(route):
                    nonlocal gate_status
                    path = urlsplit(route.request.url).path
                    if CHALLENGE_PATH.search(path):
                        gate_status = "blocked"
                        blocked.set()
                    if blocked.is_set():
                        await route.abort()
                    else:
                        await route.continue_()

                def on_response(response):
                    nonlocal gate_status
                    if urlsplit(response.url).hostname == "www.linkedin.com":
                        if response.status == 429:
                            gate_status = "rate_limited"
                            blocked.set()
                        elif response.status in (403, 999):
                            gate_status = "blocked"
                            blocked.set()

                await context.route("**/*", route_request)
                context.on("response", on_response)
                authenticated = False

                async def watch():
                    nonlocal gate_status
                    while not blocked.is_set():
                        try:
                            await page_gate(page, allow_login=not authenticated)
                        except BridgeError as exc:
                            gate_status = exc.status
                            blocked.set()
                            break
                        except Exception:
                            if page.is_closed():
                                gate_status = "network_error"
                                blocked.set()
                                break
                            # A navigation can temporarily destroy the execution context.
                        await asyncio.sleep(0.2)
                    return gate_status

                async def run():
                    nonlocal authenticated
                    try:
                        await wait_for_manual_login(page)
                    except TimeoutError:
                        raise BridgeError("auth_required", "manual_login_timeout") from None
                    authenticated = True
                    return await scrape_current_page(mode, page, args)

                monitor = asyncio.create_task(watch())
                operation = asyncio.create_task(run())
                done, _ = await asyncio.wait((operation, monitor), return_when=asyncio.FIRST_COMPLETED)
                if monitor in done or blocked.is_set():
                    raise BridgeError(gate_status, "browser_access_gate")
                result = await operation
                result["observedAt"] = now()
                return result
            finally:
                # Cancel before closing so swallowed vendor exceptions cannot restart work.
                for task in (operation, monitor):
                    if task is not None:
                        task.cancel()
                for task in (operation, monitor):
                    if task is not None:
                        with suppress(asyncio.CancelledError, Exception):
                            await task
                if context is not None:
                    with suppress(Exception):
                        await context.close()
                if browser is not None:
                    with suppress(Exception):
                        await browser.close()
    except BridgeError:
        raise
    except Exception as exc:
        # Do not expose exception messages: browser/vendor diagnostics may contain PII.
        raise vendor_error(exc) from None


def vendor_error(exc):
    """Map vendor access exceptions by type so blocks are not reported as outages."""
    names = {cls.__name__ for cls in type(exc).__mro__}
    if "RateLimitError" in names:
        # The vendor raises this for checkpoints and CAPTCHAs as well as throttling.
        return BridgeError("blocked", "vendor_access_gate")
    if "AuthenticationError" in names:
        return BridgeError("auth_required", "vendor_authentication")
    return BridgeError("network_error", "browser_operation_failed")


async def browser_availability():
    from playwright.async_api import async_playwright

    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(PROJECT / ".tools" / "browsers"))
    async with async_playwright() as playwright:
        executable = Path(playwright.chromium.executable_path)
        return {"available": executable.is_file(), "runtimeAvailable": True}


def status():
    packages = {}
    for module, distribution in (
        ("jobspy.linkedin", "python-jobspy"),
        ("linkedin_scraper.scrapers.person", "linkedin-scraper"),
        ("linkedin_scraper.scrapers.company_posts", "linkedin-scraper"),
        ("requests", "requests"), ("truststore", "truststore"),
        ("playwright.async_api", "playwright"),
    ):
        info = {"importable": False, "version": None}
        try:
            importlib.import_module(module)
            info["importable"] = True
            with suppress(importlib.metadata.PackageNotFoundError):
                info["version"] = importlib.metadata.version(distribution)
        except Exception:
            info["error"] = "import_failed"
        packages[module] = info
    browser = {"available": False, "runtimeAvailable": False}
    if packages["playwright.async_api"]["importable"]:
        try:
            browser = asyncio.run(browser_availability())
        except Exception:
            browser["error"] = "runtime_unavailable"
    ready = packages["jobspy.linkedin"]["importable"] and packages["requests"]["importable"]
    interactive = all(packages[m]["importable"] for m in (
        "linkedin_scraper.scrapers.person", "linkedin_scraper.scrapers.company_posts", "playwright.async_api"
    )) and browser["available"]
    return {"status": "ok" if ready and interactive else "unavailable",
            "python": sys.version.split()[0], "packages": packages, "browser": browser,
            "capabilities": {"jobs": ready, "profile": interactive, "company_posts": interactive},
            "interactiveLoginRequired": True, "sessionPersistence": False}


def dispatch(payload):
    mode = None
    try:
        mode, args = validate(payload)
        if mode == "status":
            return status()
        if mode == "jobs":
            return jobs(args)
        if not args["interactiveLogin"]:
            return {"status": "auth_required", "reason": "interactive_login_required",
                    "interactiveLoginRequired": True, "sessionPersistence": False}
        return asyncio.run(browser_operation(mode, args))
    except BridgeError as exc:
        result = {"status": exc.status, "reason": exc.reason}
    except (ImportError, ModuleNotFoundError):
        result = {"status": "unavailable", "reason": "dependency_unavailable"}
    except Exception:
        result = {"status": "error", "reason": "operation_failed"}
    if mode == "jobs":
        result["jobs"] = []
    return result


def read_request(stream):
    raw = stream.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise BridgeError("invalid_request", "input_limit_exceeded")

    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(value):
        raise ValueError("nonfinite number")

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError, RecursionError):
        raise BridgeError("invalid_request", "invalid_json") from None


def main(stdin=None, stdout=None):
    stdin = stdin if stdin is not None else sys.stdin.buffer
    if stdout is None:
        # Reserve the real fd 1 for the single JSON line. Child processes and native
        # code inherit fd 1, so point it at stderr for everything else.
        sys.stdout.flush()
        stdout = os.fdopen(os.dup(1), "w", encoding="ascii")
        os.dup2(2, 1)
    # Silence all library stdout, including import-time prints. Never emit library
    # diagnostics/exception messages because they can include emails or profile data.
    logging.disable(logging.CRITICAL)
    with redirect_stdout(io.StringIO()):
        try:
            result = dispatch(read_request(stdin))
        except BridgeError as exc:
            result = {"status": exc.status, "reason": exc.reason}
    stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False) + "\n")
    stdout.flush()


if __name__ == "__main__":
    main()
