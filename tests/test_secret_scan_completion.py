"""Failure-oriented checks for the private history process completion receipt."""
import copy
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import secret_scan


class HistoryCompletionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="history-completion-test-")
        self.addCleanup(self.folder.cleanup)
        self.repository = pathlib.Path(self.folder.name) / "source"
        self.trace = pathlib.Path(self.folder.name) / "trace.json"
        common = {"sid": "synthetic-history-process", "thread": "main"}
        self.rows = [
            {**common, "event": "version", "evt": "4"},
            {**common, "event": "start", "argv": [
                "git", "-C", str(self.repository), "log", "-p", "-U0",
                "--all", "--full-history", "--diff-merges=first-parent",
                "--text", "--no-ext-diff", "--no-textconv",
            ]},
            {**common, "event": "exit", "code": 0},
            {**common, "event": "atexit", "code": 0},
        ]

    def write_rows(self, rows):
        self.trace.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def rejected(self, rows):
        self.write_rows(rows)
        with self.assertRaises(secret_scan.HistoryCompletionError):
            secret_scan.require_history_completion(self.trace, self.repository)

    def test_completed_history_with_separate_remote_metadata_failure(self):
        other = copy.deepcopy(self.rows)
        for row in other:
            row["sid"] = "synthetic-remote-metadata-process"
        other[1]["argv"] = ["git", "remote", "get-url", "origin"]
        other[2]["code"] = other[3]["code"] = 2
        self.write_rows(other + self.rows)
        secret_scan.require_history_completion(self.trace, self.repository)

    def test_missing_failed_signaled_or_out_of_order_completion(self):
        cases = [[], self.rows[1:], self.rows[:-1], self.rows[:2] + self.rows[3:],
                 self.rows[:2] + list(reversed(self.rows[2:]))]
        for field in (2, 3):
            for code in (73, -9, False, 0.0):
                rows = copy.deepcopy(self.rows)
                rows[field]["code"] = code
                cases.append(rows)
        cases.append(self.rows[:2] + [{"sid": self.rows[0]["sid"], "event": "signal", "signo": 9}])
        for rows in cases:
            with self.subTest(rows=rows):
                self.rejected(rows)

    def test_wrong_command_session_or_format_cannot_substitute(self):
        cases = []
        for change in ("arguments", "repository", "session", "format", "thread"):
            rows = copy.deepcopy(self.rows)
            if change == "arguments":
                rows[1]["argv"].remove("--text")
            elif change == "repository":
                rows[1]["argv"][2] += "-other"
            elif change == "session":
                rows[3]["sid"] = "different-process"
            elif change == "format":
                rows[0]["evt"] = "5"
            else:
                rows[2]["thread"] = "different-thread"
            cases.append(rows)
        for rows in cases:
            with self.subTest(rows=rows):
                self.rejected(rows)

    def test_duplicate_or_post_shutdown_events_are_ambiguous(self):
        other = copy.deepcopy(self.rows)
        for row in other:
            row["sid"] = "duplicate-history-process"
        cases = [self.rows + other, self.rows + self.rows,
                 self.rows[:3] + [self.rows[2]] + self.rows[3:],
                 self.rows + [{"sid": self.rows[0]["sid"], "event": "data"}]]
        for rows in cases:
            with self.subTest(rows=rows):
                self.rejected(rows)

    def test_malformed_truncated_duplicate_key_and_unreadable_trace(self):
        with self.assertRaises(secret_scan.HistoryCompletionError):
            secret_scan.require_history_completion(self.trace, self.repository)
        self.write_rows(self.rows)
        valid = self.trace.read_bytes()
        cases = [b"not JSON\n", b"[]\n", b"{}\n", b"\xff\n", valid[:-1],
                 b"[" * 2000 + b"]" * 2000 + b"\n",
                 valid.replace(b'"code": 0', b'"code": 73, "code": 0', 1),
                 valid.replace(b'"code": 0', b'"code": NaN', 1)]
        for raw in cases:
            with self.subTest(raw=raw):
                self.trace.write_bytes(raw)
                with self.assertRaises(secret_scan.HistoryCompletionError):
                    secret_scan.require_history_completion(self.trace, self.repository)

    def test_private_receipt_resource_bounds(self):
        self.write_rows(self.rows)
        for limit in ("MAX_TRACE_BYTES", "MAX_TRACE_LINE_BYTES"):
            with self.subTest(limit=limit), patch.object(secret_scan, limit, 8):
                with self.assertRaises(secret_scan.HistoryCompletionError):
                    secret_scan.require_history_completion(self.trace, self.repository)
        rows = [{"sid": f"synthetic-process-{number}", "event": "version"} for number in range(65)]
        self.rejected(rows + self.rows)


if __name__ == "__main__":
    unittest.main()
