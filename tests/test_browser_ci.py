import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/browser-ci.yml"


class BrowserCiContractTests(unittest.TestCase):
    """Protect the browser job's published commands and safety contract."""

    def test_one_browser_workflow_covers_prs_and_main(self):
        workflows = list((ROOT / ".github/workflows").glob("*.yml"))
        browser_workflows = [
            path for path in workflows
            if "run: npm run test:browser" in path.read_text(encoding="utf-8")
        ]
        self.assertEqual(browser_workflows, [WORKFLOW])
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("on:\n  pull_request:\n  push:\n    branches: [main]", text)
        self.assertNotIn("pull_request_target", text)
        self.assertNotIn("paths:", text)
        self.assertNotIn("continue-on-error", text)

    def test_browser_job_has_read_only_pinned_actions_and_bounded_evidence(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("permissions:\n  contents: read", text)
        self.assertIn("persist-credentials: false", text)
        self.assertNotIn("secrets.", text)
        actions = re.findall(r"uses: ([^\s]+)", text)
        self.assertEqual(len(actions), 3)
        for action in actions:
            self.assertRegex(action, r"^actions/(checkout|setup-node|upload-artifact)@[a-f0-9]{40}$")
        for setting in (
            "timeout-minutes: 20", "timeout-minutes: 2", "if: always()",
            "retention-days: 7", "include-hidden-files: false",
            "playwright-report/", "test-results/browser/",
        ):
            self.assertIn(setting, text)

    def test_commands_use_locked_browser_and_existing_package_scripts(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
        commands = re.findall(r"^\s+run: (.+)$", text, re.MULTILINE)
        self.assertEqual(commands, [
            "npm install --global " + package["packageManager"],
            "npm ci",
            "npx --no-install playwright install --with-deps chromium",
            "npm run build",
            "npm run typecheck",
            "npm run test:browser",
        ])
        for script in ("build", "typecheck", "test:browser"):
            self.assertIn(script, package["scripts"])
        self.assertEqual(package["scripts"]["pretypecheck"], "npm run format:check")
        playwright = package["devDependencies"]["@playwright/test"]
        self.assertRegex(playwright, r"^\d+\.\d+\.\d+$")
        self.assertEqual(lock["packages"]["node_modules/@playwright/test"]["version"], playwright)
        self.assertIn("tsc --noEmit -p apps/web/tsconfig.browser.json", package["scripts"]["test:browser"])


if __name__ == "__main__":
    unittest.main()
