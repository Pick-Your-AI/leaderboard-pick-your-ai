"""Verify incremental publication links without fabricating missing issue numbers."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
from render_docs import published_issue_urls, render


class PublicationLinkTests(unittest.TestCase):
    def test_partial_publication_links_recorded_objects_only(self):
        base = "https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/"
        documents = render(publication_data={"issue_urls": {
            "LB": base + "71",
            "LB-01": base + "82",
            "LB-01.01": base + "104",
        }})
        delivery = documents["docs/DELIVERY_PLAN.md"]
        self.assertIn(f"[Program]({base}71)", delivery)
        self.assertIn(f"| [LB-01]({base}82) |", delivery)
        self.assertIn(f"### [LB-01: Product charter and contribution governance]({base}82)", delivery)
        self.assertIn(f"#### [LB-01.01: Define audiences, journeys and success]({base}104)", delivery)
        self.assertIn("#### LB-01.02: Approve metric and recognition policy", delivery)
        self.assertNotIn("[LB-01.02:", delivery)

    def test_url_and_html_url_records_are_supported(self):
        url = "https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/1"
        self.assertEqual({"LB": url}, published_issue_urls({"issue_urls": {"LB": {"url": url, "number": 1}}}))
        self.assertEqual({"LB": url}, published_issue_urls({"issue_urls": {"LB": {"html_url": url}}}))

    def test_non_issue_and_injected_urls_are_rejected(self):
        for url in ["https://example.org/issues/1", "javascript:alert(1)", "https://github.com/o/r/issues/0", "https://github.com/o/r/issues/1?token=secret"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                published_issue_urls({"issue_urls": {"LB": url}})


if __name__ == "__main__":
    unittest.main()
