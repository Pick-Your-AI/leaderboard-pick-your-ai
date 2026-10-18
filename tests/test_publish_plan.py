"""Synthetic-only interrupted publication and no-duplicate reconciliation proofs."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from publish_plan import (Journal, NAMESPACE, PublicationError, UncertainAction,
                          collect_inventory, digest, pending_resolved, publication_bindings, publish,
                          reconcile, render_issue, specs_from_backlog, verification_receipt)

ROOT = Path(__file__).resolve().parents[1]
REPO = "https://github.com/synthetic/publication-test"


def spec(key, parent=None):
    result = {"id": key, "title": key + " synthetic outcome", "outcome": "Synthetic only",
              "issue_type": "Feature" if "." not in key else "Task", "status": "Backlog",
              "readiness": "Awaiting decision", "labels": [], "assignees": []}
    if parent:
        result["parent"] = parent
    if "." in key:
        result["tasks"] = [{"id": key + ".T1", "title": "Synthetic checklist", "done": False}]
        result["acceptance_criteria"] = ["Synthetic acceptance"]
    return result


class SyntheticAdapter:
    """No network; faults occur on either side of the simulated remote commit."""
    def __init__(self):
        self.issues = []
        self.calls = []
        self.fail_before = None
        self.fail_after = None
        self.reads = 0

    def inventory(self):
        self.reads += 1
        pages = []
        chunks = [self.issues[i:i + 2] for i in range(0, len(self.issues), 2)] + [[]]
        for i, chunk in enumerate(chunks):
            pages.append({"cursor": None if i == 0 else str(i),
                          "next_cursor": str(i + 1) if i + 1 < len(chunks) else None,
                          "source_count": len(chunk), "issues": copy.deepcopy(chunk)})
        return {"repository_url": REPO, "state": "all", "pages": pages}

    def fault(self, kind, before):
        field = "fail_before" if before else "fail_after"
        if getattr(self, field) == kind:
            setattr(self, field, None)
            raise RuntimeError("Synthetic interrupted " + kind)

    def create_issue(self, payload):
        self.fault("create_issue", True)
        number = len(self.issues) + 1
        self.issues.append({"number": number, "id": 1000 + number, **copy.deepcopy(payload),
                            "parent_number": None, "parent_readback": True, "state": "open",
                            "assignees": [], "project_fields": {"Status": "Backlog"}})
        self.calls.append(("create_issue", number))
        self.fault("create_issue", False)

    def attach_parent(self, child_number, parent_number, *, replace):
        assert replace is False
        self.fault("attach_parent", True)
        child = next(i for i in self.issues if i["number"] == child_number)
        if child["parent_number"] is not None:
            raise AssertionError("Attempted duplicate or conflicting relationship")
        child["parent_number"] = parent_number
        self.calls.append(("attach_parent", child_number, parent_number))
        self.fault("attach_parent", False)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "receipts.json"
        self.specs = [spec("LB"), spec("LB-01", "LB"), spec("LB-01.01", "LB-01")]
        self.adapter = SyntheticAdapter()

    def journal(self):
        return Journal(self.path, REPO, self.specs)

    def apply(self, **kwargs):
        return publish(self.specs, REPO, self.adapter, self.journal(), dry_run=False, **kwargs)

    def test_default_dry_run_has_no_remote_or_local_writes(self):
        result = publish(self.specs, REPO, self.adapter, self.journal())
        self.assertEqual(5, len(result["actions"]))
        self.assertFalse(result["noop"])
        self.assertEqual([], self.adapter.calls)
        self.assertEqual([], list(Path(self.temp.name).iterdir()))

    def test_partial_budget_resumes_then_reruns_with_no_duplicate_issues_or_edges(self):
        first = self.apply(max_mutations=2)
        self.assertEqual(2, first["mutations"])
        self.assertFalse(first["noop"])
        durable = json.loads(self.path.read_text())
        self.assertEqual(2, len(durable["bindings"]))
        self.assertIsNone(durable["pending"])
        second = self.apply()
        self.assertTrue(second["noop"])
        self.assertEqual(3, second["mutations"])
        original = copy.deepcopy(self.adapter.issues)
        for _ in range(3):
            self.assertEqual(0, self.apply()["mutations"])
        self.assertEqual(3, len(self.adapter.issues))
        self.assertEqual(5, len(self.adapter.calls))
        self.assertEqual(original, self.adapter.issues)
        self.assertEqual([None, 1, 2], [i["parent_number"] for i in original])

    def test_crash_after_create_before_receipt_is_reconciled_from_marker(self):
        self.adapter.fail_after = "create_issue"
        with self.assertRaisesRegex(RuntimeError, "Synthetic"):
            self.apply()
        state = json.loads(self.path.read_text())
        self.assertEqual({}, state["bindings"])
        self.assertEqual({"kind": "create_issue", "plan_id": "LB"}, state["pending"])
        self.assertEqual(1, len(self.adapter.issues))
        self.assertTrue(self.apply()["noop"])
        self.assertEqual(3, len(self.adapter.issues))
        self.assertEqual(5, len(self.adapter.calls))

    def test_crash_after_relationship_before_receipt_does_not_duplicate_edge(self):
        self.adapter.fail_after = "attach_parent"
        with self.assertRaises(RuntimeError):
            self.apply()
        self.assertEqual("attach_parent", json.loads(self.path.read_text())["pending"]["kind"])
        self.assertTrue(self.apply()["noop"])
        self.assertEqual(2, sum(call[0] == "attach_parent" for call in self.adapter.calls))

    def test_uncertain_absent_create_is_never_retried(self):
        self.adapter.fail_before = "create_issue"
        with self.assertRaises(RuntimeError):
            self.apply()
        with self.assertRaises(UncertainAction):
            self.apply()
        self.assertEqual([], self.adapter.calls)
        self.assertIsNotNone(json.loads(self.path.read_text())["pending"])

    def test_uncertain_absent_parent_link_is_never_retried(self):
        self.adapter.fail_before = "attach_parent"
        with self.assertRaises(RuntimeError):
            self.apply()
        with self.assertRaises(UncertainAction):
            self.apply()
        self.assertEqual(2, len(self.adapter.calls))

    def test_extra_pending_intent_key_cannot_retry_an_uncertain_parent_link(self):
        self.adapter.fail_before = "attach_parent"
        with self.assertRaises(RuntimeError):
            self.apply()
        state = json.loads(self.path.read_text())
        state["pending"]["unexpected"] = "corrupt"
        self.path.write_text(json.dumps(state))
        before_calls = copy.deepcopy(self.adapter.calls)
        before_receipt = self.path.read_bytes()
        with self.assertRaisesRegex(PublicationError, "noncanonical"):
            self.apply()
        self.assertEqual(before_calls, self.adapter.calls)
        self.assertEqual(before_receipt, self.path.read_bytes())
        self.assertIsNone(self.adapter.issues[1]["parent_number"])

    def test_extra_pending_create_key_retains_intent_even_after_remote_success(self):
        self.adapter.fail_after = "create_issue"
        with self.assertRaises(RuntimeError):
            self.apply()
        state = json.loads(self.path.read_text())
        state["pending"]["parent_id"] = "LB-01"
        self.path.write_text(json.dumps(state))
        before_receipt = self.path.read_bytes()
        with self.assertRaisesRegex(PublicationError, "noncanonical"):
            self.apply()
        self.assertEqual(1, len(self.adapter.calls))
        self.assertEqual(before_receipt, self.path.read_bytes())

    def test_pending_parent_requires_positive_edge_readback_even_with_empty_actions(self):
        self.apply(max_mutations=2)
        inventory = self.adapter.inventory()
        report = reconcile(self.specs, inventory, REPO)
        report["actions"] = []  # Omission is not affirmative evidence of an edge.
        intent = {"kind": "attach_parent", "plan_id": "LB-01", "parent_id": "LB"}
        with self.assertRaises(UncertainAction):
            pending_resolved(intent, report, inventory, REPO)

    def test_concurrent_body_progress_assignee_and_project_edits_are_preserved(self):
        self.apply(max_mutations=2)
        for issue in self.adapter.issues:
            issue.update(state="closed", assignees=["synthetic-owner"], labels=["human-label"],
                         project_fields={"Status": "Done", "Priority": "P2"})
            issue["body"] += "\nHuman edit and - [x] accepted task\n"
            issue["title"] += " (human revised title)"
        before = copy.deepcopy(self.adapter.issues)
        self.assertTrue(self.apply()["noop"])
        for i, old in enumerate(before):
            actual = copy.deepcopy(self.adapter.issues[i])
            actual["parent_number"] = old["parent_number"]
            self.assertEqual(old, actual)
        self.assertEqual("Backlog", self.adapter.issues[2]["project_fields"]["Status"])
        self.assertIn("Awaiting decision", self.adapter.issues[2]["body"])

    def test_rendered_tasks_are_checklists_and_no_child_issue_lists_are_added(self):
        payload = render_issue(self.specs[2])
        self.assertIn("- [ ] `LB-01.01.T1` Synthetic checklist", payload["body"])
        self.assertIn("<!-- " + NAMESPACE + "LB-01.01 -->", payload["body"])
        self.assertEqual({"title", "body", "labels", "issue_type"}, set(payload))
        self.assertNotIn("children", payload["body"])

    def test_duplicate_marker_and_ambiguous_multiple_markers_fail_closed(self):
        self.apply()
        for mode in ["same_issue", "other_issue", "malformed", "unknown"]:
            with self.subTest(mode=mode):
                inventory = self.adapter.inventory()
                issue = inventory["pages"][0]["issues"][0]
                if mode == "same_issue":
                    issue["body"] += "\n<!-- " + NAMESPACE + "LB -->"
                elif mode == "other_issue":
                    inventory["pages"][0]["issues"][1]["body"] = issue["body"]
                elif mode == "malformed":
                    issue["body"] += "\n<!-- " + NAMESPACE + "not-an-id -->"
                else:
                    issue["body"] = "<!-- " + NAMESPACE + "LB-99 -->"
                with self.assertRaises(PublicationError):
                    reconcile(self.specs, inventory, REPO)

    def test_missing_marker_on_known_number_never_creates_replacement(self):
        self.apply()
        self.adapter.issues[0].update(body="Human replaced text", title="Changed completely")
        with self.assertRaisesRegex(PublicationError, "do not recreate"):
            self.apply()
        self.assertEqual(5, len(self.adapter.calls))

    def test_unmarked_planned_title_is_ambiguous_even_without_receipt(self):
        self.adapter.create_issue(render_issue(self.specs[0]))
        self.adapter.issues[0]["body"] = "Marker removed"
        with self.assertRaisesRegex(PublicationError, "Unmarked"):
            reconcile(self.specs, self.adapter.inventory(), REPO)

    def test_receipt_number_and_immutable_id_mismatches_fail_closed(self):
        self.apply()
        for binding in [{"number": 99}, {"number": 1, "id": 999}]:
            with self.subTest(binding=binding), self.assertRaises(PublicationError):
                reconcile(self.specs, self.adapter.inventory(), REPO, {"LB": binding})

    def test_supplied_and_durable_id_conflict_is_rejected_before_reads_or_writes(self):
        self.apply()
        before_receipt = self.path.read_bytes()
        before_calls = copy.deepcopy(self.adapter.calls)
        before_reads = self.adapter.reads
        for binding in [{"number": 1, "id": 999999}, {"number": 99, "id": 1001},
                        {"id": 1001}, {"number": True}, {"number": 1, "id": True}]:
            with self.subTest(binding=binding), self.assertRaises(PublicationError):
                self.apply(bindings={"LB": binding})
            self.assertEqual(before_receipt, self.path.read_bytes())
            self.assertEqual(before_calls, self.adapter.calls)
            self.assertEqual(before_reads, self.adapter.reads)
        self.assertTrue(self.apply(bindings={"LB": {"number": 1, "id": 1001}})["noop"])
        self.assertTrue(self.apply(bindings={"LB": {"number": 1}})["noop"])

    def test_historical_urls_are_constraints_not_proof_of_live_existence(self):
        publication = {"issue_urls": {"LB": REPO + "/issues/1"}}
        bindings = publication_bindings(publication, self.specs, REPO)
        with self.assertRaises(PublicationError):
            reconcile(self.specs, self.adapter.inventory(), REPO, bindings)
        for urls in [{"LB": "https://github.com/other/repo/issues/1"},
                     {"LB": REPO + "/issues/1", "LB-01": REPO + "/issues/1"},
                     {"LB-99": REPO + "/issues/1"}]:
            with self.subTest(urls=urls), self.assertRaises(PublicationError):
                publication_bindings({"issue_urls": urls}, self.specs, REPO)

    def test_wrong_native_parent_or_root_parent_never_reparents(self):
        self.apply()
        for index, parent in [(0, 2), (1, 999), (2, 1)]:
            with self.subTest(index=index):
                old = self.adapter.issues[index]["parent_number"]
                self.adapter.issues[index]["parent_number"] = parent
                with self.assertRaises(PublicationError):
                    self.apply()
                self.adapter.issues[index]["parent_number"] = old
        self.assertEqual(5, len(self.adapter.calls))

    def test_unread_native_parent_fails_before_mutation(self):
        self.adapter.create_issue(render_issue(self.specs[0]))
        self.adapter.issues[0].pop("parent_readback")
        with self.assertRaisesRegex(PublicationError, "readback"):
            self.apply()
        self.assertEqual(1, len(self.adapter.calls))

    def test_missing_closed_issue_scope_and_broken_pagination_are_rejected(self):
        self.apply()
        for mode in ["open", "truncated", "missing_cursor", "loop", "extra", "duplicate"]:
            with self.subTest(mode=mode):
                inventory = self.adapter.inventory()
                if mode == "open":
                    inventory["state"] = "open"
                elif mode == "truncated":
                    inventory["pages"].pop()
                elif mode == "missing_cursor":
                    inventory["pages"][-1].pop("next_cursor")
                elif mode == "loop":
                    inventory["pages"][1]["cursor"] = None
                elif mode == "extra":
                    inventory["pages"][0]["next_cursor"] = None
                else:
                    inventory["pages"][1]["issues"][0] = inventory["pages"][0]["issues"][0]
                with self.assertRaises(PublicationError):
                    reconcile(self.specs, inventory, REPO)

    def test_collect_inventory_follows_all_pages_and_rejects_cycles_and_bounds(self):
        self.apply()
        expected = self.adapter.inventory()
        pages = {p["cursor"]: p for p in expected["pages"]}
        self.assertEqual(expected, collect_inventory(REPO, pages.__getitem__))
        pages["1"]["next_cursor"] = "1"
        with self.assertRaises(PublicationError):
            collect_inventory(REPO, pages.__getitem__)
        with mock.patch("publish_plan.MAX_PAGES", 1), self.assertRaises(PublicationError):
            collect_inventory(REPO, pages.__getitem__)

    def test_journal_scope_corruption_plan_drift_and_lock_are_rejected(self):
        self.apply(max_mutations=1)
        with self.journal().lock(), self.assertRaisesRegex(PublicationError, "lock"):
            self.apply()
        self.specs[1]["title"] += " changed"
        with self.assertRaises(PublicationError):
            self.apply()
        self.path.write_text("{truncated")
        with self.assertRaises(PublicationError):
            self.apply()

    def test_intent_persistence_failure_prevents_remote_mutation(self):
        with mock.patch("publish_plan.os.replace", side_effect=OSError("disk failed")):
            with self.assertRaises(OSError):
                self.apply()
        self.assertEqual([], self.adapter.calls)

    def test_failing_completion_write_resumes_using_durable_intent(self):
        original = Journal.save
        count = 0

        def fail_third_save(journal, state):
            nonlocal count
            count += 1
            if count == 3:
                raise OSError("Synthetic receipt disk failure after create")
            return original(journal, state)

        with mock.patch.object(Journal, "save", fail_third_save), self.assertRaises(OSError):
            self.apply()
        self.assertEqual(1, len(self.adapter.issues))
        self.assertEqual("create_issue", json.loads(self.path.read_text())["pending"]["kind"])
        self.assertTrue(self.apply()["noop"])
        self.assertEqual(5, len(self.adapter.calls))

    def test_unrelated_issue_is_not_modified_or_counted_as_planned_work(self):
        self.adapter.issues.append({"id": 777, "number": 99, "title": "Unrelated", "body": "Keep me"})
        before = copy.deepcopy(self.adapter.issues[0])
        self.assertTrue(self.apply()["noop"])
        self.assertEqual(before, self.adapter.issues[0])

    def test_verification_receipt_is_sanitized_and_requires_complete_noop(self):
        report = reconcile(self.specs, self.adapter.inventory(), REPO)
        with self.assertRaises(PublicationError):
            verification_receipt(self.specs, self.adapter.inventory(), REPO, report, observed_at="synthetic")
        self.apply()
        inventory = self.adapter.inventory()
        report = reconcile(self.specs, inventory, REPO)
        receipt = verification_receipt(self.specs, inventory, REPO, report, observed_at="synthetic")
        self.assertEqual(3, len(receipt["records"]))
        self.assertEqual(2, receipt["result"]["verified_parent_edges"])
        self.assertNotIn("Synthetic checklist", json.dumps(receipt))
        self.assertEqual(digest(inventory), receipt["inventory_sha256"])

    def test_real_baseline_flattens_to_133_specs_and_474_checklist_tasks(self):
        backlog = json.loads((ROOT / "planning/project-backlog.json").read_text())
        specs = specs_from_backlog(backlog)
        self.assertEqual(133, len(specs))
        self.assertEqual(132, sum(s.get("parent") is not None for s in specs))
        self.assertEqual(474, sum(len(s.get("tasks", [])) for s in specs))
        self.assertEqual(474, sum(render_issue(s)["body"].count("- [ ] `LB-") for s in specs))

    def test_full_plan_synthetic_publication_resumes_and_has_exactly_132_edges(self):
        self.specs = specs_from_backlog(json.loads((ROOT / "planning/project-backlog.json").read_text()))
        self.assertFalse(self.apply(max_mutations=71)["noop"])
        self.assertTrue(self.apply(max_mutations=1000)["noop"])
        before = copy.deepcopy(self.adapter.issues)
        self.assertEqual(0, self.apply()["mutations"])
        self.assertEqual(133, len(self.adapter.issues))
        self.assertEqual(132, sum(i["parent_number"] is not None for i in self.adapter.issues))
        self.assertEqual(265, len(self.adapter.calls))
        self.assertEqual(before, self.adapter.issues)

    def test_invalid_plan_and_rendered_duplicate_marker_stop_before_any_side_effect(self):
        for mode in ["duplicate", "wrong_parent", "bad_body"]:
            with self.subTest(mode=mode):
                original = copy.deepcopy(self.specs)
                if mode == "duplicate":
                    self.specs.append(self.specs[-1])
                elif mode == "wrong_parent":
                    self.specs[1]["parent"] = "LB-99"
                else:
                    self.specs[1]["outcome"] = "<!-- " + NAMESPACE + "LB -->"
                with self.assertRaises(PublicationError):
                    self.apply()
                self.assertEqual([], self.adapter.calls)
                self.specs = original

    def test_corrupt_pending_parent_intent_is_not_accepted_as_completed(self):
        self.apply()
        state = json.loads(self.path.read_text())
        state["pending"] = {"kind": "attach_parent", "plan_id": "LB-01.01", "parent_id": "LB"}
        self.path.write_text(json.dumps(state))
        with self.assertRaises(PublicationError):
            self.apply()
        self.assertEqual(5, len(self.adapter.calls))

    def test_cli_is_offline_read_only_and_has_no_apply_flag(self):
        self.apply()
        inventory_file = Path(self.temp.name) / "inventory.json"
        publication_file = Path(self.temp.name) / "publication.json"
        backlog_file = Path(self.temp.name) / "backlog.json"
        inventory_file.write_text(json.dumps(self.adapter.inventory()))
        publication_file.write_text(json.dumps({"repository_url": REPO, "issue_urls": {}}))
        backlog_file.write_text(json.dumps({"program": self.specs[0],
            "epics": [{**self.specs[1], "work_packages": [self.specs[2]]}]}))
        args = [sys.executable, str(ROOT / "scripts/publish_plan.py"), "--inventory", str(inventory_file),
                "--publication", str(publication_file), "--backlog", str(backlog_file)]
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(json.loads(result.stdout)["noop"])
        self.assertEqual(2, subprocess.run(args + ["--apply"], capture_output=True).returncode)


if __name__ == "__main__":
    unittest.main()
