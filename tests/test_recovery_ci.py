from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/recovery-ci.yml"


class RecoveryCiContractTests(unittest.TestCase):
    """Keep the real synthetic restore drill reachable and isolated in hosted CI."""

    def test_recovery_runs_on_every_pr_and_main_push_without_secrets(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("on:\n  pull_request:\n  push:\n    branches: [main]", text)
        self.assertIn("runs-on: ubuntu-24.04", text)
        self.assertIn("permissions:\n  contents: read", text)
        self.assertIn("persist-credentials: false", text)
        for forbidden in (
            "pull_request_target", "paths:", "continue-on-error", "secrets.",
            "DATABASE_URL", "environment:", "self-hosted", "npm ",
        ):
            self.assertNotIn(forbidden, text)
        actions = re.findall(r"uses: ([^\s]+)", text)
        self.assertEqual(len(actions), 3)
        for action in actions:
            self.assertRegex(action, r"^actions/(checkout|setup-node|upload-artifact)@[a-f0-9]{40}$")

    def test_container_is_unique_network_isolated_and_resource_bounded(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(
            "RECOVERY_TEST_CONTAINER: leaderboard-task-recovery-${{ github.run_id }}-${{ github.run_attempt }}",
            text,
        )
        for setting in (
            'docker run --detach --name "$RECOVERY_TEST_CONTAINER"',
            "--network none --memory 512m --cpus 1",
            "--tmpfs /var/lib/postgresql/data:rw,size=256m",
            "--env POSTGRES_USER=leaderboard",
            "--env POSTGRES_PASSWORD=synthetic-test-only",
            "--env POSTGRES_DB=leaderboard_recovery_test",
            "postgres:17-alpine",
            "for attempt in {1..30}; do",
            "pg_isready -h 127.0.0.1 -U leaderboard -d leaderboard_recovery_test -t 2",
            "timeout-minutes: 10",
        ):
            self.assertIn(setting, text)
        for forbidden in ("--publish", "--privileged", "--network host", "docker prune"):
            self.assertNotIn(forbidden, text)
        self.assertNotRegex(text, r"--volume(?:\s|=)")
        self.assertEqual(text.count("timeout-minutes: 3"), 2)
        # Do not weaken the existing destructive-target guard to accommodate CI.
        drill = (ROOT / "infra/recovery/test/postgres.test.mjs").read_text(encoding="utf-8")
        self.assertIn('const container = process.env.RECOVERY_TEST_CONTAINER;', drill)
        self.assertIn('assert.match(container, /^leaderboard-task-[a-zA-Z0-9-]+$/);', drill)

    def test_existing_drill_cannot_silently_skip_or_hide_failure(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("shell: bash", text)  # Actions' explicit bash uses -e -o pipefail.
        self.assertIn(
            "node --test --test-reporter=tap infra/recovery/test/*.test.mjs | tee test-results/recovery/synthetic-postgres.tap",
            text,
        )
        self.assertIn("grep -qx '# skipped 0' test-results/recovery/synthetic-postgres.tap", text)
        self.assertNotIn("|| true", text)

    def test_cleanup_always_precedes_bounded_synthetic_evidence_upload(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        cleanup = text.split("- name: Remove only the dedicated synthetic container and its volumes\n", 1)[1]
        cleanup, evidence = cleanup.split("- name: Retain synthetic recovery evidence\n", 1)
        self.assertIn("if: always()", cleanup)
        self.assertIn("timeout-minutes: 1", cleanup)
        self.assertIn('docker container inspect "$RECOVERY_TEST_CONTAINER"', cleanup)
        self.assertIn('docker rm --force --volumes "$RECOVERY_TEST_CONTAINER"', cleanup)
        for setting in (
            "if: always()", "timeout-minutes: 2", "retention-days: 7",
            "path: test-results/recovery/synthetic-postgres.tap", "include-hidden-files: false",
        ):
            self.assertIn(setting, evidence)
        self.assertNotIn(".lbbackup", evidence)


if __name__ == "__main__":
    unittest.main()
