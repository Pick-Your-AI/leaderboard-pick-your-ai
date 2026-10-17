"""Failure-oriented tests for the plan's cross-document integrity checks."""
import copy
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
from validate_plan import load_bundle, validate_bundle, validate_files


class PlanIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = load_bundle()

    def setUp(self):
        self.bundle = copy.deepcopy(self.baseline)

    def assert_rejected(self, fragment):
        errors = validate_bundle(self.bundle)
        self.assertTrue(any(fragment in error for error in errors), errors)

    def test_checked_in_plan_is_cohesive(self):
        self.assertEqual([], validate_bundle(self.bundle))

    def test_duplicate_task_identity_rejected(self):
        tasks = self.bundle["backlog"]["epics"][0]["work_packages"][0]["tasks"]
        tasks[1]["id"] = tasks[0]["id"]
        self.assert_rejected("Duplicate plan IDs")

    def test_cycle_between_valid_packages_rejected(self):
        first, second = self.bundle["backlog"]["epics"][0]["work_packages"][:2]
        first["blocked_by"] = [second["id"]]
        second["blocked_by"] = [first["id"]]
        self.assert_rejected("Dependency cycle")

    def test_missing_prerequisite_rejected(self):
        self.bundle["backlog"]["epics"][0]["work_packages"][0]["blocked_by"] = ["LB-99.99"]
        self.assert_rejected("unknown prerequisite")

    def test_missing_metric_mapping_rejected(self):
        self.bundle["metric_map"]["mappings"].pop()
        self.assert_rejected("Metric mapping must cover every metric")

    def test_silent_metric_meaning_change_rejected(self):
        self.bundle["metrics"]["metrics"][0]["definition"]["numerator"] = "count every duplicate observation"
        self.assert_rejected("definition differs")

    def test_foreign_ui_task_evidence_rejected(self):
        self.bundle["ui_map"]["mappings"][0]["master_evidence"][0]["task_ids"] = ["LB-20.01.T1"]
        self.assert_rejected("unknown or mismatched UI task")

    def test_dangling_release_gate_rejected(self):
        self.bundle["release"]["required_for_every_public_release"].append("LB-99.01")
        self.assert_rejected("release: unknown package")

    def test_embedded_source_credentials_rejected(self):
        ref = self.bundle["backlog"]["epics"][0]["work_packages"][0]["references"][0]
        ref["url"] = "https://username:password@example.org/evidence"
        self.assert_rejected("source URL must be public HTTPS without credentials")

    def test_project_field_drift_rejected(self):
        self.bundle["backlog"]["epics"][0]["work_packages"][0]["readiness"] = "Probably done"
        self.assert_rejected("invalid Readiness")

    def test_backlog_fingerprint_survives_windows_line_endings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / "planning/ui").mkdir(parents=True)
            text = '{\n  "baseline": true\n}\n'
            (root / "planning/project-backlog.json").write_bytes(text.replace("\n", "\r\n").encode())
            digest = hashlib.sha256(text.encode()).hexdigest()
            (root / "planning/ui/ui-backlog-coverage.json").write_text(json.dumps({"master_sha256": digest}), encoding="utf-8")
            self.assertEqual([], validate_files(root))


if __name__ == "__main__":
    unittest.main()
