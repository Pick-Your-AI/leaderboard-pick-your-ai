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

    def test_ui_metadata_maps_every_definition_without_enabling_sources(self):
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
        self.assertEqual(ui["decision_state"], "candidate")
        self.assertEqual(ui["version"], "leaderboard-ui/v1")
        self.assertFalse(ui["public_enabled"])
        self.assertEqual({entry["metric_id"] for entry in ui["metrics"]},
                         {entry["id"] for entry in candidate["metrics"]})
        self.assertEqual(len(ui["metrics"]), 98)
        definitions = {entry["id"]: entry for entry in candidate["metrics"]}
        for entry in ui["metrics"]:
            self.assertEqual(entry["department"], definitions[entry["metric_id"]]["family"])
            for case in entry["verification_cases"]:
                self.assertTrue((ROOT / case).is_file(), case)
            if entry["maturity"] in ("definition_only", "deferred"):
                self.assertFalse(entry["supported_combinations"])
                self.assertIsNone(entry["default_combination"])
                self.assertFalse(entry["lead_view"]["wall"])
        self.assertFalse(candidate["grouping_policies"][0]["public_enabled"])
        self.assertNotIn("universal_score", candidate)


if __name__ == "__main__":
    unittest.main()
