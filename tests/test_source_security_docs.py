import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class SourceSecurityCandidateTests(unittest.TestCase):
    def test_security_candidate_traces_high_risk_boundaries(self):
        text = (ROOT / "docs/security-candidate.md").read_text(encoding="utf-8")
        for issue in ("#39", "#41", "#45", "#108"):
            self.assertIn(issue, text)
        for required in (
            "forged",
            "XSS",
            "SSRF",
            "unknown",
            "test and owner role",
            "implemented boundaries",
            "local receiver verifies signatures",
            "escaped plain text only",
            "meta CSP cannot enforce",
            "does not deploy a host",
            "No app installation or permission grant is authorized",
        ):
            self.assertIn(required.lower(), text.lower())

    def test_capability_matrix_keeps_live_probe_claims_pending(self):
        text = (ROOT / "docs/source-capability-candidate.md").read_text(encoding="utf-8")
        for family in (
            "Native issue fields and issue types",
            "Project item custom fields",
            "Project item status transitions",
            "Project progress-update posts",
        ):
            self.assertIn(family, text)
        self.assertIn("unprobed / not enabled", text.lower())
        self.assertIn("a successful call from a personal token cannot promote a family", text)

    def test_source_fixtures_are_synthetic_and_contain_no_credentials(self):
        fixtures = sorted((ROOT / "tests/fixtures/source-security").glob("*.json"))
        self.assertGreaterEqual(len(fixtures), 2)
        for fixture in fixtures:
            document = json.loads(fixture.read_text(encoding="utf-8"))
            serialized = json.dumps(document).lower()
            self.assertIn("synthetic", serialized)
            self.assertNotIn("authorization", serialized)
            self.assertNotIn("bearer ", serialized)


if __name__ == "__main__":
    unittest.main()
