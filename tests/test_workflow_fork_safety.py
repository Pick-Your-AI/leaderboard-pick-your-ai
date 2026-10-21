"""Static fork-PR safety audit of every GitHub Actions workflow.

Pull-request checks must run fork-controlled code without privileged
credentials. This is source/configuration evidence only: it does not prove a
fork-origin run was observed. It uses only the standard library because CI runs
these tests without installing dependencies, so the audit reads the repository's
plain block-style workflow layout instead of parsing arbitrary YAML.

Universal rules (every workflow): no pull_request_target or other
pull-request-adjacent privileged trigger, actions pinned to full commit SHAs,
checkout without persisted credentials, and no checkout of a pull-request head.
Strict rules (workflows reachable from a pull request, directly or through a
workflow_run chain): read-only permissions, no secret other than GITHUB_TOKEN,
no deployment environment, only allowlisted GitHub-hosted runners, and guarded workflow_run jobs.
A push-only deploy workflow may therefore hold deployment secrets.
"""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"

# Triggers that run with the base repository's credentials on pull-request
# input, so they are never acceptable without a separately reviewed design.
PRIVILEGED_PR_TRIGGERS = {
    "pull_request_target", "pull_request_review", "pull_request_review_comment",
    "issue_comment",
}
# workflow_run runs with the base repository's context. When reachable from a
# pull request it is accepted only if every job is limited to trusted
# same-repository pushes on main.
WORKFLOW_RUN_GUARDS = (
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
)
PINNED_ACTION = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$")
UNTRUSTED_REF = re.compile(r"github\.(?:head_ref|event\.pull_request\.head)")
# GitHub-hosted runner labels; anything else (self-hosted, groups, custom or
# larger-runner labels, expressions) is unreviewed and rejected for PR code.
HOSTED_RUNNER = re.compile(
    r"ubuntu-(?:latest|\d{2}\.\d{2}(?:-arm)?)|windows-(?:latest|\d{4}|11-arm)"
    r"|macos-(?:latest|\d+(?:-(?:intel|large|xlarge))?)"
)
LOCAL_WORKFLOW = re.compile(r"\./\.github/workflows/([\w.-]+\.ya?ml)")
BLOCK_SCALAR = re.compile(r"^(-\s+)?(?:run|script):\s*[|>][+-]?\d*\s*$")


def scan(text):
    """Return (indent, line, in_body) for each meaningful line.

    Structural lines have comments removed. Bodies of `run:`/`script:` block
    scalars are kept (flagged in_body) because `${{ }}` expressions there are
    evaluated, but they are never read as workflow keys.
    """
    result = []
    body_indent = None
    for raw in text.splitlines():
        stripped = raw.strip()
        indent = len(raw) - len(raw.lstrip(" "))
        if body_indent is not None:
            if not stripped or indent > body_indent:
                if stripped:
                    result.append((indent, stripped, True))
                continue
            body_indent = None
        if not stripped or stripped.startswith("#"):
            continue
        if not re.search(r"""["']""", stripped):
            stripped = re.sub(r"\s+#.*$", "", stripped)
        result.append((indent, stripped, False))
        block = BLOCK_SCALAR.match(stripped)
        if block:
            body_indent = indent + (len(block.group(1)) if block.group(1) else 0)
    return result


def structure(text):
    return [(indent, line) for indent, line, body in scan(text) if not body]


def _block(entries, index):
    indent = entries[index][0]
    body = []
    for child in entries[index + 1:]:
        if child[0] <= indent:
            break
        body.append(child)
    return body


def trigger_blocks(text):
    """Map each event in the top-level `on:` to its child entries."""
    entries = structure(text)
    for index, (indent, line) in enumerate(entries):
        match = re.fullmatch(r"""["']?on["']?:\s*(.*)""", line)
        if indent != 0 or not match:
            continue
        if match.group(1):
            return {event: [] for event in re.findall(r"[a-z_]+", match.group(1))}
        children = _block(entries, index)
        found = {}
        key_indent = children[0][0] if children else 0
        for position, (child_indent, child) in enumerate(children):
            key = re.match(r"([a-z_]+):", child)
            if child_indent == key_indent and key:
                found[key.group(1)] = _block(children, position)
        return found
    return {}


def triggers(text):
    return set(trigger_blocks(text))


def jobs(text):
    """Yield (job_name, property_indent, entries) for each job."""
    entries = structure(text)
    for index, (indent, line) in enumerate(entries):
        if indent == 0 and line == "jobs:":
            children = _block(entries, index)
            if not children:
                return
            job_indent = children[0][0]
            for position, (child_indent, child) in enumerate(children):
                name = re.fullmatch(r"""["']?([\w-]+)["']?:""", child)
                if child_indent == job_indent and name:
                    body = _block(children, position)
                    yield name.group(1), (body[0][0] if body else job_indent + 2), body
            return


def workflow_name(text, fallback):
    for indent, line in structure(text):
        match = re.fullmatch(r"name:\s*(.+)", line)
        if indent == 0 and match:
            return match.group(1).strip("'\"")
    return fallback


def run_sources(text):
    """Names listed under workflow_run.workflows."""
    block = trigger_blocks(text).get("workflow_run", [])
    joined = "\n".join(line for _, line in block)
    inline = re.search(r"workflows:\s*\[(.*?)\]", joined)
    if inline:
        items = inline.group(1).split(",")
    else:
        items = re.findall(r"^-\s*(.+)$", joined, re.M)
    return [item.strip().strip("'\"") for item in items if item.strip()]


def local_calls(text):
    """Basenames of local reusable workflows called by this workflow's jobs."""
    called = []
    for _, indent, body in jobs(text):
        target = _property(body, indent, "uses") or ""
        match = LOCAL_WORKFLOW.fullmatch(target.strip("'\""))
        if target.strip("'\"").startswith("./"):
            called.append(match.group(1) if match else target)
    return called


def pr_reachable(texts):
    """Return the set of workflow keys reachable from a pull request.

    Reachability follows workflow_run chains and local reusable-workflow calls.
    Anything that cannot be traced to a push-only origin counts as reachable.
    """
    events = {key: triggers(text) for key, text in texts.items()}
    names = {workflow_name(text, key): key for key, text in texts.items()}
    by_file = {Path(key).name: key for key in texts}
    callers = {key: [] for key in texts}
    for key, text in texts.items():
        for target in local_calls(text):
            if target in by_file:
                callers[by_file[target]].append(key)
    reach = {key for key, found in events.items() if "pull_request" in found}
    changed = True
    while changed:
        changed = False
        for key, text in texts.items():
            if key in reach:
                continue
            found = events[key]
            reachable = False
            if "workflow_run" in found:
                sources = run_sources(text)
                # An unresolvable source cannot be proven PR-free, so it counts.
                reachable |= not sources or any(
                    names.get(name) in reach or name not in names for name in sources)
            if "workflow_call" in found:
                # No resolvable caller means it can be called from anywhere.
                reachable |= not callers[key] or any(caller in reach for caller in callers[key])
            if reachable:
                reach.add(key)
                changed = True
    return reach


def _branches(block):
    joined = "\n".join(line for _, line in block)
    inline = re.search(r"^branches:\s*\[(.*?)\]", joined, re.M)
    if inline:
        return [item.strip().strip("'\"") for item in inline.group(1).split(",")]
    listed = re.search(r"^branches:\s*\n((?:-\s*\S+\n?)+)", joined + "\n", re.M)
    if listed:
        return [item.strip().strip("'\"") for item in re.findall(r"^-\s*(\S+)", listed.group(1), re.M)]
    return None


def _property(body, indent, key):
    """Return (inline value + nested lines) for a job-level property, or None."""
    for position, (child_indent, line) in enumerate(body):
        match = re.fullmatch(key + r":\s*(.*)", line)
        if child_indent == indent and match:
            parts = [match.group(1)]
            for deeper_indent, deeper in body[position + 1:]:
                if deeper_indent <= indent:
                    break
                parts.append(deeper)
            return re.sub(r"\s+", " ", " ".join(parts))
    return None


def _runner_problem(body, indent):
    """Return a description if runs-on is not purely allowlisted hosted labels."""
    for position, (child_indent, line) in enumerate(body):
        match = re.fullmatch(r"runs-on:\s*(.*)", line)
        if child_indent != indent or not match:
            continue
        inline = match.group(1)
        nested = []
        for deeper_indent, deeper in body[position + 1:]:
            if deeper_indent <= indent:
                break
            nested.append(deeper)
        labels = []
        if inline.startswith("["):
            labels = [item.strip().strip("'\"") for item in inline.strip("[]").split(",")]
        elif inline:
            labels = [inline.strip("'\"")]
        for item in nested:
            if not item.startswith("- "):
                return f"mapping form ({item})"  # group:, labels: and the like
            labels.append(item[2:].strip().strip("'\""))
        if not labels or not all(HOSTED_RUNNER.fullmatch(label) for label in labels):
            return ", ".join(labels) or "empty"
        return None
    # A job calling a reusable workflow has no runner of its own.
    return None if _property(body, indent, "uses") is not None else "missing runs-on"


def _permission_problems(text):
    problems = []
    entries = structure(text)
    top = 0
    for index, (indent, line) in enumerate(entries):
        match = re.fullmatch(r"permissions:\s*(.*)", line)
        if not match:
            continue
        top += indent == 0
        value = match.group(1)
        if value:
            if value not in ("{}", "read-all", "none"):
                problems.append(f"permissions grant more than read: {value}")
            continue
        for _, child in _block(entries, index):
            allowed = r"[a-z-]+: (?:read|none)" if indent else r"contents: read|[a-z-]+: none"
            if not re.fullmatch(allowed, child):
                problems.append(f"permissions grant more than contents: read: {child}")
    if top != 1:
        problems.append("missing top-level permissions (use contents: read)")
    return problems


def audit(text, reachable=None):
    """Return fork-PR safety violations for one workflow's text.

    `reachable` says whether a pull request can run the workflow; by default it
    is inferred from this file alone (pull_request, workflow_run or workflow_call).
    """
    problems = []
    blocks = trigger_blocks(text)
    events = set(blocks)
    if reachable is None:
        reachable = bool(events & {"pull_request", "workflow_run", "workflow_call"})
    entries = scan(text)
    structural = structure(text)
    if not events:
        problems.append("no recognizable trigger block")
    for event in sorted(events & PRIVILEGED_PR_TRIGGERS):
        problems.append(f"uses privileged pull-request trigger {event}")

    # Universal: immutable actions (local reusable workflows are reviewed in repo).
    for _, line in structural:
        match = re.match(r"(?:-\s+)?uses:\s*(\S+)", line)
        if match and not match.group(1).startswith("./") and not PINNED_ACTION.fullmatch(match.group(1)):
            problems.append(f"action not pinned to a full commit SHA: {match.group(1)}")

    # Universal: checkout never persists the token or fetches a PR head.
    for index, (_, line) in enumerate(structural):
        if not re.search(r"\buses:\s*actions/checkout@", line):
            continue
        start = index
        while start > 0 and not structural[start][1].startswith("- "):
            start -= 1
        step_indent = structural[start][0]
        step = [structural[start][1]]
        for child_indent, child in structural[start + 1:]:
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

    if not any(True for _ in jobs(text)):
        problems.append("no jobs could be parsed (job-level checks would be skipped)")

    if not reachable:
        return problems

    # Strict: nothing a pull request can run may hold privilege.
    problems += _permission_problems(text)
    # Only `${{ }}` expressions reference secrets; step names and quoted literals
    # that merely mention the word do not. Run bodies are included because their
    # expressions are evaluated before the shell sees them.
    for expression in re.findall(r"\$\{\{(.*?)\}\}", "\n".join(line for _, line, _ in entries), re.S):
        if re.search(r"\bsecrets\b(?!\.GITHUB_TOKEN\b)", re.sub(r"'[^']*'", "''", expression)):
            problems.append("references a secret other than GITHUB_TOKEN")
            break
    for name, indent, body in jobs(text):
        if _property(body, indent, "secrets") is not None:
            problems.append(f"job {name} passes secrets")
        if _property(body, indent, "environment") is not None:
            problems.append(f"job {name} uses a deployment environment")
        runner = _runner_problem(body, indent)
        if runner:
            problems.append(f"job {name} runner is not an allowlisted GitHub-hosted label: {runner}")
        if "workflow_run" in events:
            condition = _property(body, indent, "if") or ""
            for guard in WORKFLOW_RUN_GUARDS:
                if guard not in condition:
                    problems.append(f"job {name} lacks workflow_run guard: {guard}")
    if "workflow_run" in events and _branches(blocks["workflow_run"]) != ["main"]:
        problems.append("workflow_run trigger is not limited to branches: [main]")
    return problems


def audit_all(texts):
    """Audit {key: text}, inferring pull-request reachability across files."""
    reach = pr_reachable(texts)
    known = {Path(key).name for key in texts}
    result = {}
    for key, text in texts.items():
        result[key] = audit(text, key in reach)
        if key in reach:
            for target in local_calls(text):
                if target not in known:
                    result[key].append(f"calls unresolvable local workflow {target}")
    return result


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

# Deployment-style content that is acceptable only when no pull request can run it.
DEPLOY = """name: Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - run: ./deploy.sh
        env:
          TOKEN: ${{ secrets.DEPLOY_KEY }}
"""

# workflow_run workflow whose guards are all present in the job and trigger.
RUN_GOOD = """name: Follow

on:
  workflow_run:
    workflows: [Fixture]
    types: [completed]
    branches: [main]

permissions:
  contents: read

jobs:
  follow:
    if: >-
      ${{ github.event.workflow_run.event == 'push' &&
          github.event.workflow_run.head_branch == 'main' &&
          github.event.workflow_run.head_repository.full_name == github.repository }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
          persist-credentials: false
"""


class WorkflowForkSafetyTests(unittest.TestCase):
    """Source evidence for 'fork PR tests run without privileged credentials'."""

    def texts(self):
        paths = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
        self.assertGreaterEqual(len(paths), 6)
        return {path.name: path.read_text(encoding="utf-8") for path in paths}

    def test_every_workflow_passes_the_audit(self):
        for name, problems in audit_all(self.texts()).items():
            with self.subTest(workflow=name):
                self.assertEqual(problems, [])

    def test_known_pull_request_checks_are_covered(self):
        texts = self.texts()
        reach = pr_reachable(texts)
        self.assertTrue({
            "browser-ci.yml", "recovery-ci.yml", "runtime-ci.yml",
            "validate-ingestion.yml", "validate-plan.yml",
        } <= {name for name, text in texts.items() if "pull_request" in triggers(text)})
        # The post-checks site preparation follows a PR-triggered workflow, so it
        # is held to the strict rules even though its guards limit it to main.
        self.assertEqual(triggers(texts["prepare-site.yml"]), {"workflow_run"})
        self.assertIn("prepare-site.yml", reach)

    def test_audit_accepts_the_fixture_baselines(self):
        self.assertEqual(audit(GOOD), [])
        self.assertEqual(triggers(GOOD), {"pull_request", "push"})
        self.assertEqual(audit(RUN_GOOD), [])
        self.assertEqual(audit_all({"good.yml": GOOD, "run.yml": RUN_GOOD}),
                         {"good.yml": [], "run.yml": []})

    def rejected(self, mutate, expected, base=GOOD):
        text = mutate(base)
        self.assertNotEqual(text, base, "mutation did not change the fixture")
        problems = audit(text)
        self.assertTrue(
            any(expected in problem for problem in problems),
            f"expected {expected!r} in {problems!r}",
        )

    def test_rejects_pull_request_target_and_privileged_pr_triggers(self):
        self.rejected(lambda t: t.replace("  pull_request:\n", "  pull_request_target:\n"), "pull_request_target")
        self.rejected(lambda t: t.replace("on:\n  pull_request:\n  push:\n    branches: [main]", "on: [pull_request_target]"), "pull_request_target")
        self.rejected(lambda t: t.replace("  pull_request:\n", "  issue_comment:\n"), "issue_comment")
        # Universal: also rejected where the strict rules do not apply.
        self.assertTrue(audit(DEPLOY.replace("  push:\n    branches: [main]", "  pull_request_target:"), reachable=False))

    def test_rejects_non_github_token_secrets(self):
        for snippet in (
            "      - run: deploy\n        env:\n          TOKEN: ${{ secrets.DEPLOY_KEY }}\n",
            "      - run: deploy\n        env:\n          ALL: ${{ toJSON(secrets) }}\n",
            "      - run: deploy\n        env:\n          X: ${{ secrets['DEPLOY_KEY'] }}\n",
            "      - run: |\n          echo ${{ secrets.DEPLOY_KEY }}\n",
        ):
            self.rejected(lambda t, s=snippet: t + s, "secret other than GITHUB_TOKEN")
        self.rejected(lambda t: t.replace("jobs:\n", "jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n"), "passes secrets")

    def test_rejects_write_or_missing_or_broadened_permissions(self):
        self.rejected(lambda t: t.replace("contents: read", "contents: write"), "permissions")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read\n\n", ""), "missing top-level permissions")
        self.rejected(lambda t: t.replace("contents: read", "contents: read\n  pull-requests: write"), "permissions")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read", "permissions: write-all"), "permissions")
        self.rejected(
            lambda t: t.replace("    runs-on:", "    permissions:\n      id-token: write\n    runs-on:"),
            "permissions",
        )

    def test_accepts_stricter_permission_forms(self):
        for replacement in ("permissions: {}", "permissions: read-all", "permissions: none"):
            self.assertEqual(audit(GOOD.replace("permissions:\n  contents: read", replacement)), [])
        self.assertEqual(audit(GOOD.replace("    runs-on:", "    permissions: {}\n    runs-on:")), [])
        self.assertEqual(audit(GOOD.replace("    runs-on:", "    permissions:\n      contents: read\n    runs-on:")), [])

    def test_unpinned_actions_rejected_but_local_reusable_workflows_skipped(self):
        self.rejected(lambda t: t.replace("@3d3c42e5aac5ba805825da76410c181273ba90b1", "@v4"), "not pinned")
        self.rejected(lambda t: t.replace("@3d3c42e5aac5ba805825da76410c181273ba90b1", "@3d3c42e"), "not pinned")
        self.assertEqual(audit(GOOD.replace("jobs:\n", "jobs:\n  local:\n    uses: ./.github/workflows/x.yml\n")), [])
        self.rejected(lambda t: t.replace("jobs:\n", "jobs:\n  remote:\n    uses: org/repo/.github/workflows/x.yml@main\n"), "not pinned")

    def test_rejects_persisted_checkout_credentials_and_untrusted_refs(self):
        self.rejected(lambda t: t.replace("persist-credentials: false", "persist-credentials: true"), "persist-credentials")
        self.rejected(lambda t: t.replace("        with:\n          persist-credentials: false\n", ""), "persist-credentials")
        self.rejected(
            lambda t: t.replace("          persist-credentials: false\n",
                                "          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}\n"),
            "untrusted pull-request ref",
        )

    def test_rejects_environments(self):
        self.rejected(lambda t: t.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: production\n"), "environment")

    def test_runner_labels_are_allowlisted(self):
        for runner in (
            "self-hosted", "[self-hosted, linux]", "[ubuntu-latest, gpu]", "my-gpu-runner",
            "ubuntu-latest-4-cores", "${{ matrix.os }}", "''",
        ):
            self.rejected(lambda t, r=runner: t.replace("runs-on: ubuntu-latest", f"runs-on: {r}"), "allowlisted GitHub-hosted")
        for nested in (
            "runs-on:\n      labels: self-hosted",
            "runs-on:\n      group: large-runners",
            "runs-on:\n      group: large-runners\n      labels: ubuntu-latest",
            "runs-on:\n      - self-hosted",
        ):
            self.rejected(lambda t, n=nested: t.replace("runs-on: ubuntu-latest", n), "allowlisted GitHub-hosted")
        self.rejected(lambda t: t.replace("    runs-on: ubuntu-latest\n", ""), "allowlisted GitHub-hosted")
        for runner in (
            "ubuntu-24.04", "ubuntu-22.04-arm", "windows-2022", "windows-latest", "macos-14",
            "macos-latest", "[ubuntu-24.04]", "'ubuntu-latest'", "runs-on:\n      - ubuntu-latest",
        ):
            text = GOOD.replace("runs-on: ubuntu-latest", runner if runner.startswith("runs-on:") else f"runs-on: {runner}")
            self.assertEqual(audit(text), [], runner)
        # Strict rules apply only to PR-reachable workflows.
        self.assertEqual(audit(DEPLOY.replace("ubuntu-latest", "self-hosted"), reachable=False), [])
        self.assertTrue(audit(DEPLOY.replace("ubuntu-latest", "self-hosted"), reachable=True))

    def test_quoted_job_ids_are_parsed_and_unparsed_jobs_fail_safe(self):
        self.assertEqual(audit(GOOD.replace("  checks:", '  "checks":')), [])
        self.rejected(lambda t: t.replace("  checks:", '  "checks":').replace(
            "ubuntu-latest", "self-hosted"), "allowlisted GitHub-hosted")
        self.rejected(lambda t: t.replace("  checks:", "  'checks':").replace(
            "runs-on: ubuntu-latest", "runs-on: ubuntu-latest\n    environment: prod"), "environment")
        # Job-level checks cannot silently vanish when the jobs block is not understood.
        self.rejected(lambda t: t.replace("  checks:", "  ? checks"), "no jobs could be parsed")
        self.rejected(lambda t: t.replace("jobs:\n", "jobs: {}\n"), "no jobs could be parsed")

    def test_reusable_workflow_callees_inherit_pull_request_reachability(self):
        caller = GOOD.replace("jobs:\n", "jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n")
        callee = DEPLOY.replace("  push:\n    branches: [main]", "  workflow_call:").replace("name: Deploy", "name: Callee")
        results = audit_all({"caller.yml": caller, "callee.yml": callee})
        self.assertEqual(results["caller.yml"], [])
        for expected in ("permissions", "secret other than GITHUB_TOKEN", "deployment environment"):
            self.assertTrue(any(expected in problem for problem in results["callee.yml"]), (expected, results))
        self.assertTrue(any("allowlisted" in problem for problem in audit_all(
            {"caller.yml": caller, "callee.yml": callee.replace("ubuntu-latest", "self-hosted")})["callee.yml"]))
        # Quoted job ids and two hops still propagate.
        hop = callee.replace("name: Callee", "name: Hop").replace(
            "jobs:\n", "jobs:\n  \"next\":\n    uses: ./.github/workflows/last.yml\n")
        last = callee.replace("name: Callee", "name: Last")
        chained = audit_all({"caller.yml": caller.replace("callee.yml", "hop.yml"), "hop.yml": hop, "last.yml": last})
        self.assertTrue(chained["last.yml"])
        # A callee with no resolvable caller could be called from anywhere.
        self.assertTrue(audit_all({"callee.yml": callee})["callee.yml"])
        # An unresolvable local target from a PR-reachable caller is a violation.
        self.assertTrue(any("unresolvable" in problem for problem in audit_all(
            {"caller.yml": caller})["caller.yml"]))
        # Called only from a push-only workflow, deployment privilege is acceptable.
        push_caller = DEPLOY.replace("jobs:\n", "jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n")
        self.assertEqual(audit_all({"deploy.yml": push_caller, "callee.yml": callee}),
                         {"deploy.yml": [], "callee.yml": []})
        # ...but one PR-reachable caller among several is enough.
        both = audit_all({"deploy.yml": push_caller, "caller.yml": caller, "callee.yml": callee})
        self.assertTrue(both["callee.yml"])

    def test_push_only_deploy_passes_but_same_content_is_rejected_when_pr_reachable(self):
        self.assertEqual(audit(DEPLOY), [])
        self.assertEqual(audit_all({"deploy.yml": DEPLOY}), {"deploy.yml": []})
        self.assertEqual(audit(DEPLOY, reachable=False), [])
        # Universal rules still apply to it.
        self.assertTrue(audit(DEPLOY.replace("3d3c42e5aac5ba805825da76410c181273ba90b1", "v4")))
        self.assertTrue(audit(DEPLOY.replace("persist-credentials: false", "persist-credentials: true")))
        reachable = DEPLOY.replace("  push:\n    branches: [main]", "  pull_request:")
        problems = audit(reachable)
        for expected in ("permissions", "secret other than GITHUB_TOKEN", "deployment environment"):
            self.assertTrue(any(expected in problem for problem in problems), (expected, problems))

    def test_workflow_run_chain_makes_followers_pr_reachable(self):
        follower = DEPLOY.replace(
            "  push:\n    branches: [main]",
            "  workflow_run:\n    workflows: [Fixture]\n    types: [completed]\n    branches: [main]",
        ).replace("name: Deploy", "name: Follow")
        self.assertTrue(audit_all({"good.yml": GOOD, "follow.yml": follower})["follow.yml"])
        # Chained off a push-only workflow, no pull request can start it.
        self.assertEqual(audit_all({"deploy.yml": DEPLOY, "follow.yml": follower.replace("[Fixture]", "[Deploy]")})["follow.yml"], [])
        # Two hops, and an unresolvable source, are both treated as reachable.
        second = follower.replace("name: Follow", "name: Second").replace("[Fixture]", "[Follow]")
        self.assertTrue(audit_all({"good.yml": GOOD, "follow.yml": follower, "second.yml": second})["second.yml"])
        self.assertTrue(audit_all({"follow.yml": follower.replace("[Fixture]", "[Elsewhere]")})["follow.yml"])

    def test_workflow_run_guards_are_checked_per_job_and_in_the_trigger_block(self):
        second_job = RUN_GOOD + (
            "  other:\n    runs-on: ubuntu-latest\n    steps:\n"
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"
            "        with:\n          persist-credentials: false\n"
        )
        self.rejected(lambda t: second_job, "job other lacks workflow_run guard", RUN_GOOD)
        # One guard living only in another job's condition does not count.
        partial = RUN_GOOD.replace("github.event.workflow_run.event == 'push' &&\n          ", "")
        self.rejected(lambda t: partial, "lacks workflow_run guard: github.event.workflow_run.event", RUN_GOOD)
        # An unrelated push branches filter must not satisfy the workflow_run filter.
        no_filter = RUN_GOOD.replace("    branches: [main]\n", "").replace(
            "on:\n", "on:\n  push:\n    branches: [main]\n")
        self.rejected(lambda t: no_filter, "not limited to branches", RUN_GOOD)
        wider = RUN_GOOD.replace("branches: [main]", "branches: [main, dev]")
        self.rejected(lambda t: wider, "not limited to branches", RUN_GOOD)
        listed = RUN_GOOD.replace("    branches: [main]\n", "    branches:\n      - main\n")
        self.assertEqual(audit(listed), [])

    def test_mentions_of_privileged_words_outside_real_keys_are_not_violations(self):
        noisy = GOOD.replace(
            "      - run: echo",
            "      - name: Scan for secrets and self-hosted environment leaks\n"
            "        run: |\n"
            "          echo \"mode: write\"\n"
            "          echo \"secrets are not used; runs-on: self-hosted; environment: prod\"\n"
            "      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1\n"
            "        with:\n"
            "          node-environment: production\n"
            "          note: ${{ contains(github.event.head_commit.message, 'secrets') }}\n"
            "      # secrets.COMMENTED_OUT and permissions: write-all in a YAML comment\n"
            "      - run: echo",
        )
        self.assertNotEqual(noisy, GOOD)
        self.assertEqual(audit(noisy), [])

    def test_real_workflows_fail_when_deliberately_broken_in_memory(self):
        """Mutate the real files in memory only; nothing on disk changes."""
        texts = self.texts()
        self.assertEqual(audit_all(texts), {name: [] for name in texts})
        runtime, prepare = texts["runtime-ci.yml"], texts["prepare-site.yml"]

        def broken(name, text):
            return audit_all({**texts, name: text})[name]

        self.assertTrue(broken("runtime-ci.yml", runtime.replace("  pull_request:\n", "  pull_request_target:\n")))
        self.assertTrue(broken("runtime-ci.yml", runtime.replace("contents: read", "contents: write")))
        self.assertTrue(broken("runtime-ci.yml", runtime + "      - run: x\n        env:\n          K: ${{ secrets.NPM_TOKEN }}\n"))
        self.assertTrue(broken("prepare-site.yml", prepare.replace("github.event.workflow_run.event == 'push' &&", "")))
        self.assertTrue(broken("prepare-site.yml", prepare.replace("    branches: [main]\n", "", 1)))
        self.assertTrue(broken("prepare-site.yml", prepare.replace(
            "ref: ${{ github.event.workflow_run.head_sha }}",
            "ref: ${{ github.event.pull_request.head.sha }}", 1)))


if __name__ == "__main__":
    unittest.main()
