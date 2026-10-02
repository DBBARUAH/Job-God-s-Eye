"""Offline bridge tests. No network: requests.Session.request is replaced by fixtures."""
from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

import requests
from requests.structures import CaseInsensitiveDict

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import bridge  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SEARCH = "https://www.linkedin.com" + bridge.SEARCH_PATH
DETAIL = "https://www.linkedin.com/jobs/view/"


def fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeResponse:
    def __init__(self, url, status=200, body="", headers=None, chunks=None):
        self.status_code = status
        self.url = url
        self.headers = CaseInsensitiveDict({"Content-Type": "text/html; charset=utf-8", **(headers or {})})
        self._chunks = chunks if chunks is not None else [body.encode("utf-8")]
        self.closed = False

    def iter_content(self, chunk_size=1):
        yield from self._chunks

    def close(self):
        self.closed = True


class Transport:
    """Route fake responses by URL kind and record every outbound request."""

    def __init__(self, search=None, detail=None):
        self.search = list(search or [])
        self.detail = detail or (lambda url: FakeResponse(url, body=fixture("job_detail.html")))
        self.calls = []

    def __call__(self, session, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        if url.startswith(SEARCH):
            query = requests.Request("GET", url, params=kwargs.get("params")).prepare().url
            if not self.search:
                return FakeResponse(query, body="")
            item = self.search.pop(0)
            return item(query) if callable(item) else FakeResponse(query, body=item)
        return self.detail(url)


def run_jobs(transport, **args):
    request = {"searchTerm": "financial analyst", "location": "United States", "limit": 2, **args}
    def send(session, method, url, **kwargs):  # a function, so it binds as a method
        return transport(session, method, url, **kwargs)

    with mock.patch.object(requests.Session, "request", send):
        return bridge.dispatch({"mode": "jobs", "args": request})


class ValidateTests(unittest.TestCase):
    def test_accepts_bounded_requests_with_defaults(self):
        self.assertEqual(bridge.validate({"mode": "status"}), ("status", {}))
        mode, args = bridge.validate({"mode": "jobs", "args": {"searchTerm": " FP&A "}})
        self.assertEqual((mode, args), ("jobs", {"searchTerm": "FP&A", "location": "United States", "limit": 10}))
        mode, args = bridge.validate({"mode": "profile", "args": {"url": "https://www.linkedin.com/in/example-person"}})
        self.assertEqual(args, {"url": "https://www.linkedin.com/in/example-person/", "limit": 5, "interactiveLogin": False})
        mode, args = bridge.validate({"mode": "company_posts", "args": {"url": "https://www.linkedin.com/company/example-corp/", "limit": 3}})
        self.assertEqual(args["url"], "https://www.linkedin.com/company/example-corp/")

    def test_rejects_unexpected_shapes_types_and_ranges(self):
        bad = [
            [], {"mode": "status", "extra": 1}, {"mode": "delete"}, {"mode": "status", "args": {"x": 1}},
            {"mode": "jobs", "args": []}, {"mode": "jobs", "args": {}},
            {"mode": "jobs", "args": {"searchTerm": "a", "limit": 21}},
            {"mode": "jobs", "args": {"searchTerm": "a", "limit": 0}},
            {"mode": "jobs", "args": {"searchTerm": "a", "limit": True}},
            {"mode": "jobs", "args": {"searchTerm": "a", "limit": 2.0}},
            {"mode": "jobs", "args": {"searchTerm": "a", "hoursOld": 0}},
            {"mode": "jobs", "args": {"searchTerm": "a\nb"}},
            {"mode": "jobs", "args": {"searchTerm": "x" * 301}},
            {"mode": "jobs", "args": {"searchTerm": "a", "proxy": "http://p"}},
            {"mode": "profile", "args": {"url": "https://www.linkedin.com/in/x", "limit": 6}},
            {"mode": "profile", "args": {"url": "https://www.linkedin.com/in/x", "interactiveLogin": "yes"}},
            {"mode": "profile", "args": {"url": "https://www.linkedin.com/in/x", "cookies": "li_at=1"}},
        ]
        for payload in bad:
            with self.subTest(payload=payload), self.assertRaises(bridge.BridgeError) as caught:
                bridge.validate(payload)
            self.assertEqual(caught.exception.status, "invalid_request")

    def test_linkedin_urls_are_exact(self):
        bad = [
            "http://www.linkedin.com/in/x", "https://linkedin.com/in/x", "https://www.linkedin.com.evil.test/in/x",
            "https://www.linkedin.com/in/x?trk=1", "https://www.linkedin.com/in/x#a", "https://www.linkedin.com/in/../company/x",
            "https://www.linkedin.com/in/%2e%2e", "https://user@www.linkedin.com/in/x", "https://www.linkedin.com:443/in/x",
            "https://www.linkedin.com/company/x", "https://www.linkedin.com/in/x/details/contact-info",
        ]
        for url in bad:
            with self.subTest(url=url), self.assertRaises(bridge.BridgeError):
                bridge.exact_url(url, "profile")
        with self.assertRaises(bridge.BridgeError):
            bridge.exact_url("https://www.linkedin.com/in/x", "company_posts")


class RequestParsingTests(unittest.TestCase):
    def test_input_limits_and_strict_json(self):
        self.assertEqual(bridge.read_request(io.BytesIO(b'{"mode":"status"}')), {"mode": "status"})
        for raw in [b"x" * (bridge.MAX_INPUT + 1), b"{", b'{"mode":"status","mode":"jobs"}',
                    b'{"a":NaN}', b'{"a":Infinity}', b"\xff\xfe", b"[" * 100000]:
            with self.subTest(raw=raw[:20]), self.assertRaises(bridge.BridgeError) as caught:
                bridge.read_request(io.BytesIO(raw))
            self.assertEqual(caught.exception.status, "invalid_request")

    def test_main_writes_exactly_one_ascii_json_line(self):
        out = io.StringIO()
        bridge.main(io.BytesIO(b"not json"), out)
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), {"status": "invalid_request", "reason": "invalid_json"})
        out = io.StringIO()
        with mock.patch.object(bridge, "dispatch", lambda payload: print("vendor noise") or {"status": "ok", "x": "é"}):
            bridge.main(io.BytesIO(b'{"mode":"status"}'), out)
        self.assertEqual(out.getvalue(), '{"status": "ok", "x": "\\u00e9"}\n')

    def test_profile_without_explicit_login_never_launches_browser(self):
        with mock.patch.object(bridge, "browser_operation", side_effect=AssertionError("launched")):
            result = bridge.dispatch({"mode": "profile", "args": {"url": "https://www.linkedin.com/in/example"}})
        self.assertEqual(result["status"], "auth_required")
        self.assertIs(result["sessionPersistence"], False)

    def test_unexpected_errors_do_not_leak_messages(self):
        secret = "jane.doe@example.com profile text"
        with mock.patch.object(bridge, "jobs", side_effect=RuntimeError(secret)):
            result = bridge.dispatch({"mode": "jobs", "args": {"searchTerm": "risk"}})
        self.assertEqual(result, {"status": "error", "reason": "operation_failed", "jobs": []})
        self.assertNotIn("jane", json.dumps(result))


class GateTests(unittest.TestCase):
    def test_public_page_with_hidden_modal_and_upsell_is_not_gated(self):
        self.assertIsNone(bridge.html_gate(fixture("job_detail.html"), DETAIL + "1", content_selector=bridge.DETAIL_CONTENT))

    def test_walls_challenges_and_rate_limits(self):
        cases = [
            (fixture("authwall.html"), DETAIL + "1", "blocked"),
            (fixture("challenge.html"), DETAIL + "1", "blocked"),
            ("<div class='show-more-less-html__markup'>ok</div>", "https://www.linkedin.com/authwall", "blocked"),
            ("<div class='show-more-less-html__markup'>ok</div>", "https://www.linkedin.com/checkpoint/lg", "blocked"),
            ("<p>Too many requests. Try later.</p>", DETAIL + "1", "rate_limited"),
            ("<p>Please verify you are human</p>", DETAIL + "1", "blocked"),
            ('<div hidden><iframe src="https://x.test/captcha"></iframe></div>', DETAIL + "1", "blocked"),
        ]
        for html, url, expected in cases:
            with self.subTest(expected=expected, url=url, html=html[:40]):
                self.assertEqual(bridge.html_gate(html, url, content_selector=bridge.DETAIL_CONTENT), expected)

    def test_script_mentions_are_not_visible_gates(self):
        html = "<script>var t='verify you are human too many requests';</script><p>ok</p>"
        self.assertIsNone(bridge.html_gate(html, DETAIL + "1"))

    def test_login_page_allowed_only_during_manual_login(self):
        html = fixture("authwall.html").replace('class="authwall"', "")
        self.assertEqual(bridge.html_gate(html, "https://www.linkedin.com/login"), "blocked")
        self.assertIsNone(bridge.html_gate(html, "https://www.linkedin.com/login", allow_login=True))
        self.assertEqual(bridge.html_gate(fixture("challenge.html"), "https://www.linkedin.com/login", allow_login=True), "blocked")


class CleanTextTests(unittest.TestCase):
    def test_redacts_emails_hides_scripts_and_controls(self):
        text = bridge.clean_text("<p>Mail a.b@example.com or mailto:x@y.test</p><script>steal()</script>\x07ok &amp;amp; done", html=True)
        self.assertEqual(text, "Mail [redacted] or [redacted] ok & done")

    def test_trailing_ampersand_and_plain_text_survive(self):
        # Regression: a live title ending in "FP&A" was emptied by an unflushed parser.
        self.assertEqual(bridge.clean_text("Financial Analyst - Commercial FP&A", 500), "Financial Analyst - Commercial FP&A")
        self.assertEqual(bridge.clean_text("<p>Team: FP&A", html=True), "Team: FP&A")
        self.assertEqual(bridge.clean_text("Growth <5% & margins", 500), "Growth <5% & margins")
        self.assertEqual(bridge.clean_text("Write to me@example.com", 500), "Write to [redacted]")
        self.assertEqual(bridge.clean_text(None), "")
        self.assertEqual(len(bridge.clean_text("x" * 50, 10)), 10)


class GuardedSessionTests(unittest.TestCase):
    def session(self, responder, limit=2):
        guarded = bridge.GuardedSession(limit)
        calls = []

        def fake(session, method, url, **kwargs):
            calls.append({"method": method, "url": url, **kwargs})
            return responder(url, kwargs)

        patcher = mock.patch.object(requests.Session, "request", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(guarded.close)
        return guarded, calls

    def expect(self, guarded, status, reason, url=DETAIL + "1", **kwargs):
        with self.assertRaises(bridge.BridgeError) as caught:
            guarded.get(url, **kwargs)
        self.assertEqual((caught.exception.status, caught.exception.reason), (status, reason))

    def test_detail_request_uses_verified_plain_transport(self):
        guarded, calls = self.session(lambda url, kw: FakeResponse(url, body=fixture("job_detail.html")))
        response = guarded.get(DETAIL + "1000000001")
        self.assertIn("show-more-less-html__markup", response.text)
        self.assertEqual(calls[0]["verify"], True)
        self.assertEqual(calls[0]["proxies"], {})
        self.assertEqual(calls[0]["allow_redirects"], False)
        self.assertEqual(calls[0]["timeout"], bridge.REQUEST_TIMEOUT)
        self.assertNotIn("Cookie", guarded.session.headers)
        self.assertEqual(len(guarded.session.cookies), 0)
        self.assertIs(guarded.session.trust_env, False)

    def test_search_adds_entry_level_filter(self):
        guarded, calls = self.session(lambda url, kw: FakeResponse(url, body=fixture("search_page.html")))
        guarded.get(SEARCH + "?", params={"keywords": "risk analyst", "start": 0})
        self.assertEqual(calls[0]["params"], {"keywords": "risk analyst", "start": 0, "f_E": "2"})
        self.assertEqual(guarded.cards_seen, 2)

    def test_disallowed_requests_never_reach_the_network(self):
        guarded, calls = self.session(lambda url, kw: self.fail("network reached"))
        self.expect(guarded, "blocked", "url_not_allowed", "https://www.linkedin.com/in/someone")
        cases = [
            ("blocked", "url_not_allowed", "https://evil.test/jobs/view/1", {}),
            ("blocked", "url_not_allowed", "https://www.linkedin.com/jobs/view/1?x=1", {}),
            ("unrecognized_page", "job_id_unrecognized", DETAIL + "abc", {}),
            ("blocked", "request_options_not_allowed", DETAIL + "1", {"proxies": {"https": "p"}}),
            ("blocked", "request_options_not_allowed", DETAIL + "1", {"verify": False}),
            ("blocked", "request_params_not_allowed", DETAIL + "1", {"params": {"a": 1}}),
        ]
        for status, reason, url, kwargs in cases:
            fresh, fresh_calls = self.session(lambda url, kw: self.fail("network reached"))
            with self.subTest(reason=reason, url=url):
                self.expect(fresh, status, reason, url, **kwargs)
                self.assertEqual(fresh_calls, [])
        fresh, _ = self.session(lambda url, kw: self.fail("network reached"))
        with self.assertRaises(bridge.BridgeError):
            fresh.request("POST", DETAIL + "1")
        self.assertEqual(calls, [])

    def test_http_statuses_map_to_explicit_states(self):
        cases = [(429, "rate_limited", "http_429"), (403, "blocked", "http_403"), (999, "blocked", "http_999"),
                 (302, "blocked", "redirect_rejected"), (301, "blocked", "redirect_rejected"),
                 (500, "network_error", "http_500"), (404, "network_error", "http_404")]
        for code, status, reason in cases:
            guarded, _ = self.session(lambda url, kw, code=code: FakeResponse(url, status=code))
            with self.subTest(code=code):
                self.expect(guarded, status, reason)

    def test_page_shape_and_size_failures(self):
        big = bridge.MAX_BODY + 1
        cases = [
            (lambda u, k: FakeResponse(u, headers={"Content-Type": "application/json"}, body="{}"), "unrecognized_page", "unexpected_content_type"),
            (lambda u, k: FakeResponse(u, headers={"Content-Length": str(big)}), "unrecognized_page", "body_limit_exceeded"),
            (lambda u, k: FakeResponse(u, headers={"Content-Length": "12abc"}), "unrecognized_page", "body_limit_exceeded"),
            (lambda u, k: FakeResponse(u, chunks=[b"x" * (bridge.MAX_BODY // 2 + 1)] * 2), "unrecognized_page", "body_limit_exceeded"),
            (lambda u, k: FakeResponse("https://www.linkedin.com/signup", body="<p>x</p>"), "blocked", "unexpected_response_url"),
            (lambda u, k: FakeResponse(u, body=fixture("authwall.html")), "blocked", "access_gate"),
            (lambda u, k: FakeResponse(u, body=fixture("challenge.html")), "blocked", "access_gate"),
            (lambda u, k: FakeResponse(u, body="<main>Redesigned page</main>"), "unrecognized_page", "description_markup_missing"),
        ]
        for responder, status, reason in cases:
            guarded, _ = self.session(responder)
            with self.subTest(reason=reason):
                self.expect(guarded, status, reason)

    def test_transport_exceptions_are_reported_without_messages(self):
        def boom(url, kw):
            raise requests.exceptions.ConnectionError("dns failure for secret-host")
        guarded, _ = self.session(boom)
        self.expect(guarded, "network_error", "request_failed")

    def test_first_failure_stops_all_later_requests(self):
        guarded, calls = self.session(lambda url, kw: FakeResponse(url, status=429))
        self.expect(guarded, "rate_limited", "http_429")
        self.expect(guarded, "rate_limited", "http_429", DETAIL + "2")
        self.assertEqual(len(calls), 1)
        self.assertEqual(guarded.failures, [{"status": "rate_limited", "reason": "http_429"}])

    def test_request_budget(self):
        guarded, calls = self.session(lambda url, kw: FakeResponse(url, body=fixture("job_detail.html")), limit=1)
        guarded.get(DETAIL + "1")
        guarded.get(DETAIL + "2")
        guarded.get(DETAIL + "3")
        self.expect(guarded, "limit_reached", "request_budget_exceeded", DETAIL + "4")
        self.assertEqual(len(calls), 3)

    def test_search_markup_states(self):
        guarded, _ = self.session(lambda url, kw: FakeResponse(url, body=""))
        guarded.get(SEARCH + "?", params={})
        self.assertTrue(guarded.empty_search)
        guarded, _ = self.session(lambda url, kw: FakeResponse(url, body="<section>New layout</section>"))
        self.expect(guarded, "unrecognized_page", "search_markup_changed", SEARCH + "?", params={})
        broken = fixture("search_page.html").replace('<span class="sr-only">Junior Financial Analyst</span>', "")
        guarded, _ = self.session(lambda url, kw: FakeResponse(url, body=broken))
        self.expect(guarded, "unrecognized_page", "job_card_markup_changed", SEARCH + "?", params={})


class JobsTests(unittest.TestCase):
    def test_successful_search_normalizes_and_redacts(self):
        transport = Transport(search=[fixture("search_page.html")])
        result = run_jobs(transport)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["failures"], [])
        self.assertEqual(result["requestCount"], 3)
        first, second = result["jobs"]
        self.assertEqual(first["title"], "Junior Financial Analyst")
        self.assertEqual(first["company"], "Example Corp")
        self.assertEqual(first["location"], "New York, NY")
        self.assertEqual(first["url"], DETAIL + "1000000001")
        self.assertEqual(first["publishedAt"], "2026-09-28")
        self.assertTrue(first["descriptionAvailable"])
        self.assertIn("Visa sponsorship is available for this role.", first["text"])
        self.assertNotIn("@", first["text"])
        self.assertNotIn("ignore previous instructions", first["text"])
        self.assertEqual(second["title"], "Analyst, Commercial FP&A")
        self.assertEqual(second["publishedAt"], "2026-10-01")
        self.assertNotIn("emails", first)
        search_calls = [c for c in transport.calls if c["url"].startswith(SEARCH)]
        self.assertEqual(search_calls[0]["params"]["keywords"], "financial analyst")
        self.assertEqual(search_calls[0]["params"]["f_E"], "2")

    def test_short_result_page_ends_on_empty_fragment(self):
        transport = Transport(search=[fixture("search_page.html")])
        result = run_jobs(transport, limit=5, hoursOld=48)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["jobs"]), 2)
        self.assertEqual(result["requestCount"], 4)
        self.assertEqual(transport.calls[0]["params"]["f_TPR"], "r172800")

    def test_rate_limit_on_detail_returns_partial_without_descriptions(self):
        transport = Transport(search=[fixture("search_page.html")], detail=lambda url: FakeResponse(url, status=429))
        result = run_jobs(transport)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["failures"], [{"status": "rate_limited", "reason": "http_429"}])
        self.assertEqual([job["descriptionAvailable"] for job in result["jobs"]], [False, False])
        self.assertEqual(result["requestCount"], 2, "no further requests after a rate limit")

    def test_empty_search_is_no_results(self):
        result = run_jobs(Transport(search=[""]))
        self.assertEqual((result["status"], result["jobs"], result["failures"]), ("no_results", [], []))

    def test_blocked_or_changed_search_is_never_no_results(self):
        for body, status in [(fixture("challenge.html"), "blocked"), (fixture("authwall.html"), "blocked"),
                             ("<main>Redesign</main>", "unrecognized_page"), ("<p>Too many requests</p>", "rate_limited")]:
            with self.subTest(status=status, body=body[:30]):
                result = run_jobs(Transport(search=[body]))
                self.assertEqual(result["status"], status)
                self.assertEqual(result["jobs"], [])
        result = run_jobs(Transport(search=[lambda url: FakeResponse(url, status=999)]))
        self.assertEqual(result["status"], "blocked")

    def test_dependency_missing_reports_unavailable(self):
        real_import = __import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("jobspy"):
                raise ModuleNotFoundError(name)
            return real_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", fake_import):
            result = bridge.dispatch({"mode": "jobs", "args": {"searchTerm": "risk"}})
        self.assertEqual(result, {"status": "unavailable", "reason": "dependency_unavailable", "jobs": []})


class FactsTests(unittest.TestCase):
    def test_profile_facts_are_an_allowlist(self):
        from linkedin_scraper.models.person import Contact, Education, Experience, Person
        person = Person(
            linkedin_url="https://www.linkedin.com/in/example/", name="Example Person", about="Private about text",
            location="Somewhere", experiences=[Experience(position_title=f"Analyst {i}", institution_name="Example Corp",
                                                          from_date="2024", to_date="Present", description="details") for i in range(7)],
            educations=[Education(institution_name="Example University", degree="MS Finance", from_date="2022", to_date="2024")],
            contacts=[Contact(type="email", value="person@example.com")],
        )
        facts = bridge.profile_facts(person, "Analyst at Example Corp | reach me at person@example.com", 5)
        self.assertEqual(set(facts), {"name", "headline", "work", "education"})
        self.assertEqual(len(facts["work"]), 5)
        self.assertEqual(facts["work"][0], {"title": "Analyst 0", "company": "Example Corp", "from": "2024", "to": "Present"})
        self.assertEqual(facts["education"][0]["degree"], "MS Finance")
        dumped = json.dumps(facts)
        for leaked in ("Private about", "person@example.com", "Somewhere", "details"):
            self.assertNotIn(leaked, dumped)

    def test_post_facts_validate_sources_and_keep_relative_age_only(self):
        from linkedin_scraper.models.post import Post
        posts = [
            Post(linkedin_url="https://www.linkedin.com/feed/update/urn:li:activity:123/", text="Welcome to our new analysts!", posted_date="3d"),
            Post(linkedin_url="https://evil.test/feed/update/urn:li:activity:1/", text="Congrats team", posted_date="Edited • 2w"),
            Post(linkedin_url="https://www.linkedin.com/feed/update/urn:li:activity:5/", text="", posted_date="1d"),
        ]
        facts = bridge.post_facts(posts, 5)
        self.assertEqual(len(facts), 2)
        self.assertEqual(facts[0], {"text": "Welcome to our new analysts!", "source": "https://www.linkedin.com/feed/update/urn:li:activity:123/",
                                    "publishedAt": None, "relativeAge": "3d"})
        self.assertIsNone(facts[1]["source"])
        self.assertIsNone(facts[1]["relativeAge"])

    def test_vendor_exceptions_map_by_type(self):
        from linkedin_scraper.core.exceptions import AuthenticationError, RateLimitError
        self.assertEqual(bridge.vendor_error(RateLimitError("checkpoint")).status, "blocked")
        self.assertEqual(bridge.vendor_error(AuthenticationError("x")).status, "auth_required")
        self.assertEqual(bridge.vendor_error(RuntimeError("x")).status, "network_error")


class StatusTests(unittest.TestCase):
    def test_status_shape_without_launching_a_browser(self):
        async def fake_availability():
            return {"available": False, "runtimeAvailable": True}

        with mock.patch.object(bridge, "browser_availability", fake_availability):
            result = bridge.dispatch({"mode": "status"})
        self.assertEqual(result["status"], "unavailable")
        self.assertTrue(result["capabilities"]["jobs"])
        self.assertFalse(result["capabilities"]["profile"])
        self.assertIs(result["sessionPersistence"], False)
        self.assertIsInstance(asyncio.run(fake_availability()), dict)


if __name__ == "__main__":
    unittest.main()
