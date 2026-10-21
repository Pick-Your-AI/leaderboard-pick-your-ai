"""Static fork-PR safety audit of every GitHub Actions workflow.

Pull-request checks must run fork-controlled code without privileged
credentials. This is source/configuration evidence only: it does not prove a
fork-origin run was observed. It uses only the standard library because CI runs
these tests without installing dependencies, so the audit reads the repository's
plain block-style workflow layout instead of parsing arbitrary YAML.
"""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"

# Triggers whose runs execute proposed (possibly fork) code with fork-safe
# credentials. Anything else, such as pull_request_target, issue_comment or
# schedule, needs a reviewed addition here with its own safety argument.
SAFE_TRIGGERS = {"pull_request", "push"}
# workflow_run runs with the base repository's context, so it is accepted only
# when its job is limited to trusted same-repository pushes on main.
WORKFLOW_RUN_GUARDS = (
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
)
PINNED_ACTION = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$")
UNTRUSTED_REF = re.compile(r"github\.(?:head_ref|event\.pull_request\.head)")


def _lines(text):
    """Yield (indent, stripped) for non-blank, non-comment lines."""
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped and not stripped.startswith("#"):
            yield len(raw) - len(raw.lstrip(" ")), stripped


def _children(text, header):
    """Yield (header_indent, [(indent, line), ...]) for each `header` block."""
    entries = list(_lines(text))
    for index, (indent, line) in enumerate(entries):
        if re.fullmatch(header, line):
            body = []
            for child_indent, child in entries[index + 1:]:
                if child_indent <= indent:
                    break
                body.append((child_indent, child))
            yield indent, body


def triggers(text):
    found = set()
    entries = list(_lines(text))
    for index, (indent, line) in enumerate(entries):
        match = re.fullmatch(r"""["']?on["']?:\s*(.*)""", line)
        if indent != 0 or not match:
            continue
        inline = match.group(1)
        if inline:
            found.update(re.findall(r"[a-z_]+", inline))
            continue
        for child_indent, child in entries[index + 1:]:
            if child_indent == 0:
                break
            if child_indent == 2 and (key := re.match(r"([a-z_]+):", child)):
                found.add(key.group(1))
        break
    return found


def audit(text):
    """Return a list of fork-PR safety violations in one workflow's text."""
    problems = []
    live = [line for _, line in _lines(text)]
    live_text = "\n".join(live)
    events = triggers(text)
    if not events:
        problems.append("no recognizable trigger block")
    if "pull_request_target" in live_text:
        problems.append("uses pull_request_target")
    for event in sorted(events - SAFE_TRIGGERS - {"pull_request_target"}):
        if event != "workflow_run":
            problems.append(f"unreviewed trigger {event}")
    if "workflow_run" in events:
        for guard in WORKFLOW_RUN_GUARDS:
            if guard not in live_text:
                problems.append(f"workflow_run lacks guard: {guard}")
        if "branches: [main]" not in live_text:
            problems.append("workflow_run is not limited to branches: [main]")

    # Only the automatic, repository-scoped GITHUB_TOKEN is allowed. This also
    # rejects `secrets: inherit`, `secrets[...]`, `toJSON(secrets)` and
    # environment-scoped credentials.
    if re.search(r"\bsecrets\b(?!\.GITHUB_TOKEN\b)", live_text):
        problems.append("references a secret other than GITHUB_TOKEN")
    if re.search(r"^environment:|\benvironment:", live_text, re.M):
        problems.append("uses a deployment environment")
    if "self-hosted" in live_text:
        problems.append("uses a self-hosted runner")

    # Top-level permissions must be present and exactly contents: read.
    top = [body for indent, body in _children(text, r"permissions:") if indent == 0]
    if len(top) != 1 or [line for _, line in top[0]] != ["contents: read"]:
        problems.append("top-level permissions must be exactly 'contents: read'")
    for indent, body in _children(text, r"permissions:"):
        if indent and any(not re.fullmatch(r"[a-z-]+: (?:read|none)", line) for _, line in body):
            problems.append("job-level permissions grant more than read")
    if re.search(r"^permissions:[ \t]*\S", live_text, re.M):
        problems.append("inline permissions value (use an explicit contents: read block)")
    if re.search(r"\bwrite-all\b|:\s*write\b", live_text):
        problems.append("grants write permission")

    # Every action is an immutable full-length commit SHA.
    for action in re.findall(r"\buses:\s*(\S+)", live_text):
        if not PINNED_ACTION.fullmatch(action):
            problems.append(f"action not pinned to a full commit SHA: {action}")

    # Checkout must not persist the token and must not fetch fork code with a
    # privileged context. Only the guarded workflow_run source SHA is allowed.
    entries = list(_lines(text))
    for index, (indent, line) in enumerate(entries):
        if not re.search(r"\buses:\s*actions/checkout@", line):
            continue
        start = index
        while start > 0 and not entries[start][1].startswith("- "):
            start -= 1
        step_indent = entries[start][0]
        step = [entries[start][1]]
        for child_indent, child in entries[start + 1:]:
            if child_indent <= step_indent:
                break
            step.append(child)
        step_text = "\n".join(step)
        if "persist-credentials: false" not in step_text:
            problems.append("checkout does not disable persist-credentials")
        for ref in re.findall(r"^ref:\s*(.+)$", step_text, re.M):
            if UNTRUSTED_REF.search(ref):
                problems.append(f"checkout of untrusted pull-request ref: {ref}")
            elif "github.event.workflow_run" in ref and ref.strip("${} ") != "github.event.workflow_run.head_sha":
                problems.append(f"checkout of unreviewed workflow_run ref: {ref}")
            elif "workflow_run" in ref and "workflow_run" not in events:
                problems.append(f"workflow_run ref without workflow_run trigger: {ref}")
    return problems


GOOD = """name: Fixture

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - run: echo "${{ secrets.GITHUB_TOKEN != '' }}"
"""


class WorkflowForkSafetyTests(unittest.TestCase):
    """Source evidence for 'fork PR tests run without privileged credentials'."""

    def workflows(self):
        paths = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
        self.assertGreaterEqual(len(paths), 6)
        return paths

    def test_every_workflow_passes_the_audit(self):
        for path in self.workflows():
            with self.subTest(workflow=path.name):
                self.assertEqual(audit(path.read_text(encoding="utf-8")), [])

    def test_known_pull_request_checks_are_covered(self):
        covered = {
            path.name for path in self.workflows()
            if "pull_request" in triggers(path.read_text(encoding="utf-8"))
        }
        self.assertTrue({
            "browser-ci.yml", "recovery-ci.yml", "runtime-ci.yml",
            "validate-ingestion.yml", "validate-plan.yml",
        } <= covered)
        # Post-merge preparation must never be reachable from a pull request.
        prepare = (WORKFLOWS / "prepare-site.yml").read_text(encoding="utf-8")
        self.assertEqual(triggers(prepare), {"workflow_run"})

    def test_audit_accepts_the_fixture_baseline(self):
        self.assertEqual(audit(GOOD), [])
        self.assertEqual(triggers(GOOD), {"pull_request", "push"})

    def rejected(self, mutate, expected):
        text = mutate(GOOD)
        self.assertNotEqual(text, GOOD, "mutation did not change the fixture")
        problems = audit(text)
        self.assertTrue(
            any(expected in problem for problem in problems),
            f"expected {expected!r} in {problems!r}",
        )

    def test_rejects_pull_request_target(self):
        self.rejected(lambda t: t.replace("  pull_request:\n", "  pull_request_target:\n"), "pull_request_target")
        self.rejected(lambda t: t.replace("on:\n  pull_request:\n  push:\n    branches: [main]", "on: [pull_request_target]"), "pull_request_target")

    def test_rejects_unreviewed_and_unguarded_triggers(self):
        self.rejected(lambda t: t.replace("  pull_request:\n", "  issue_comment:\n"), "unreviewed trigger")
        self.rejected(
            lambda t: t.replace("  pull_request:\n", "  workflow_run:\n    workflows: [X]\n    types: [completed]\n"),
            "workflow_run lacks guard",
        )

    def test_rejects_non_github_token_secrets(self):
        for snippet in (
            "      - run: deploy\n        env:\n          TOKEN: ${{ secrets.DEPLOY_KEY }}\n",
            "      - run: deploy\n        env:\n          ALL: ${{ toJSON(secrets) }}\n",
            "      - run: deploy\n        env:\n          X: ${{ secrets['DEPLOY_KEY'] }}\n",
        ):
            self.rejected(lambda t, s=snippet: t + s, "secret other than GITHUB_TOKEN")
        self.rejected(lambda t: t.replace("jobs:\n", "jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n"), "secret other than GITHUB_TOKEN")

    def test_rejects_write_or_missing_or_broadened_permissions(self):
        self.rejected(lambda t: t.replace("contents: read", "contents: write"), "write")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read\n\n", ""), "top-level permissions")
        self.rejected(lambda t: t.replace("contents: read", "contents: read\n  pull-requests: read"), "top-level permissions")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read", "permissions: write-all"), "write")
        self.rejected(
            lambda t: t.replace("    runs-on:", "    permissions:\n      id-token: write\n    runs-on:"),
            "job-level permissions",
        )

    def test_rejects_unpinned_actions(self):
        self.rejected(lambda t: t.replace("@3d3c42e5aac5ba805825da76410c181273ba90b1", "@v4"), "not pinned")
        self.rejected(lambda t: t.replace("@3d3c42e5aac5ba805825da76410c181273ba90b1", "@3d3c42e"), "not pinned")

    def test_rejects_persisted_checkout_credentials_and_untrusted_refs(self):
        self.rejected(lambda t: t.replace("persist-credentials: false", "persist-credentials: true"), "persist-credentials")
        self.rejected(lambda t: t.replace("        with:\n          persist-credentials: false\n", ""), "persist-credentials")
        self.rejected(
            lambda t: t.replace("          persist-credentials: false\n",
                                "          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}\n"),
            "untrusted pull-request ref",
        )

    def test_rejects_environments_and_self_hosted_runners(self):
        self.rejected(lambda t: t.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"), "environment")
        self.rejected(lambda t: t.replace("ubuntu-latest", "self-hosted"), "self-hosted")

    def test_real_workflows_fail_when_deliberately_broken_in_memory(self):
        """Mutate the real files in memory only; nothing on disk changes."""
        runtime = (WORKFLOWS / "runtime-ci.yml").read_text(encoding="utf-8")
        prepare = (WORKFLOWS / "prepare-site.yml").read_text(encoding="utf-8")
        self.assertEqual(audit(runtime), [])
        self.assertTrue(audit(runtime.replace("  pull_request:\n", "  pull_request_target:\n")))
        self.assertTrue(audit(runtime.replace("contents: read", "contents: write")))
        self.assertTrue(audit(runtime + "      - run: x\n        env:\n          K: ${{ secrets.NPM_TOKEN }}\n"))
        self.assertTrue(audit(prepare.replace("github.event.workflow_run.event == 'push' &&", "")))
        self.assertTrue(audit(prepare.replace(
            "ref: ${{ github.event.workflow_run.head_sha }}",
            "ref: ${{ github.event.pull_request.head.sha }}", 1)))


if __name__ == "__main__":
    unittest.main()
