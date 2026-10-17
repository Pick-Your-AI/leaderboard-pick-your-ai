import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ContractRegistryParityTests(unittest.TestCase):
    def test_registry_preserves_all_98_planned_metric_definitions(self):
        planned = json.loads(
            (ROOT / "planning" / "metrics-and-ingestion.json").read_text(
                encoding="utf-8"
            )
        )["metrics"]
        candidate = json.loads(
            (
                ROOT
                / "packages"
                / "metrics"
                / "src"
                / "v1"
                / "registry.json"
            ).read_text(encoding="utf-8")
        )

        self.assertEqual(candidate["contract_version"], "leaderboard-metrics/v1")
        self.assertEqual(len(planned), 98)
        self.assertEqual(candidate["metrics"], planned)
        self.assertEqual(
            len({metric["id"] for metric in candidate["metrics"]}), 98
        )

    def test_unresolved_ui_metadata_is_not_fabricated_or_enabled(self):
        candidate = json.loads(
            (
                ROOT
                / "packages"
                / "metrics"
                / "src"
                / "v1"
                / "registry.json"
            ).read_text(encoding="utf-8")
        )
        ui = candidate["ui_metadata"]
        self.assertEqual(ui["decision_state"], "unresolved")
        self.assertIn("department", ui["fields"])
        self.assertIn("lead_view", ui["fields"])
        self.assertNotIn("universal_score", candidate)


if __name__ == "__main__":
    unittest.main()
