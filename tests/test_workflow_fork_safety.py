"""Static fork-PR safety audit of every GitHub Actions workflow.

Pull-request checks must run fork-controlled code without privileged
credentials. This is source/configuration evidence only: it does not prove a
fork-origin run was observed. It uses only the standard library because CI runs
these tests without installing dependencies, so the audit reads the repository's
plain block-style workflow layout instead of parsing arbitrary YAML. Because a
hand-rolled reader can misread what it does not understand, it FAILS CLOSED:
quoted keys are normalized in one place, and any construct outside the supported
subset (flow mappings, flow sequences outside a few simple keys, anchors, aliases,
merge keys, tags, multi-document files, multi-line quoted scalars, unknown `on:`
events, unknown top-level or job-level keys) is reported as "unsupported workflow
syntax" rather than skipped.

Case rules follow GitHub: expression contexts and property names (`secrets`,
`github.head_ref`, the workflow_run guards, `GITHUB_TOKEN`), runner labels,
workflow names in `workflow_run.workflows` and boolean values are matched
case-insensitively; YAML keys, event names, permission scope names and branch
names are case-sensitive, and a miscased one is never silently skipped (it
fails the unknown-key, unknown-event or permission checks instead).

Universal rules (every workflow): no pull_request_target or other
pull-request-adjacent privileged trigger, actions pinned to full commit SHAs,
checkout without persisted credentials, and no checkout of a pull-request head.
Strict rules (workflows reachable from a pull request, directly or through a
workflow_run chain): read-only permissions, no secret other than GITHUB_TOKEN,
no deployment environment, only allowlisted GitHub-hosted runners, and guarded
workflow_run jobs.

Deployment rule: a workflow that needs secrets, an environment or write
permissions must be triggered only by push to main (or another trigger no pull
request can start) and must NOT be a workflow_run follower of a PR-triggered
workflow or a callee of one. A workflow_run follower of a PR workflow stays
PR-reachable, and therefore strict, even when its job guards look correct: the
guards are textual, and the followed run may carry fork code. Split deployment
into its own push-triggered workflow instead of relaxing this audit.
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
# pull request it is accepted only if every job's `if:` is a pure `&&`
# conjunction (no `||`) with each of these as one of its top-level terms, so the
# guards constrain every branch that can succeed; extra `&&` terms may only
# narrow it further.
WORKFLOW_RUN_GUARDS = (
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
)
PINNED_ACTION = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$")
UNTRUSTED_REF = re.compile(
    r"github\.(?:head_ref|event\.pull_request\.head|event\.pull_request\.merge_commit_sha"
    r"|event\.(?:number|pull_request\.number|issue\.number))|refs?/pull/",
    re.I,
)
SECRET_REFERENCE = re.compile(r"\bsecrets\b(?!\.GITHUB_TOKEN\b)", re.I)
# GitHub-hosted runner labels; anything else (self-hosted, groups, custom or
# larger-runner labels, expressions) is unreviewed and rejected for PR code.
HOSTED_RUNNER = re.compile(
    r"ubuntu-(?:latest|\d{2}\.\d{2}(?:-arm)?)|windows-(?:latest|\d{4}|11-arm)"
    r"|macos-(?:latest|\d+(?:-(?:intel|large|xlarge))?)",
    re.I,
)
TOP_KEYS = {"name", "run-name", "on", "permissions", "env", "defaults", "concurrency", "jobs"}
JOB_KEYS = {
    "name", "permissions", "needs", "if", "runs-on", "environment",
    "concurrency", "outputs", "env", "defaults", "steps", "timeout-minutes",
    "strategy", "continue-on-error", "container", "services", "uses", "with", "secrets",
}
LOCAL_WORKFLOW = re.compile(r"\./\.github/workflows/([\w.-]+\.ya?ml)")
# One shared key pattern; every key match in this file goes through it.
KEY = r"[A-Za-z_][\w-]*"
QUOTED_KEY = re.compile(r"^((?:-\s+)*)([\"'])(" + KEY + r")\2\s*:(?=\s|$)")
SPACED_KEY = re.compile(r"^((?:-\s+)*)(" + KEY + r")\s+:(?=\s|$)")
QUOTED_ITEM = re.compile(
    r"^((?:-\s+)+)([\"'])([A-Za-z0-9_./$](?:(?!:\s|:$|\s#)[^\"'])*)\2$")
KEY_VALUE = re.compile(r"^(" + KEY + r"):(?:\s+(.*))?$")
KNOWN_EVENTS = {
    "branch_protection_rule", "check_run", "check_suite", "create", "delete",
    "deployment", "deployment_status", "discussion", "discussion_comment", "fork",
    "gollum", "issue_comment", "issues", "label", "merge_group", "milestone",
    "page_build", "project", "project_card", "project_column", "public",
    "pull_request", "pull_request_review", "pull_request_review_comment",
    "pull_request_target", "push", "registry_package", "release",
    "repository_dispatch", "schedule", "status", "watch", "workflow_call",
    "workflow_dispatch", "workflow_run",
}
# Keys whose value drives a rule: `uses`, `ref` and `persist-credentials` must be
# inline plain scalars; the others may be blocks/lists but never folded scalars.
SCALAR_REQUIRED_KEYS = {"uses", "ref", "persist-credentials"}
SCALAR_INLINE_KEYS = {"runs-on", "workflows", "branches", "environment"}
# Keys whose quoted values are compared as literal text by a rule.
RULE_KEYS = SCALAR_REQUIRED_KEYS | SCALAR_INLINE_KEYS | {"if"}
# A simple one-line `[a, b]` value is understood for ordinary keys (filters,
# matrix values, inputs). Keys that carry workflow structure must be block style.
FLOW_SEQUENCE_FORBIDDEN_KEYS = {
    "steps", "jobs", "permissions", "uses", "environment", "secrets", "strategy",
    "matrix", "with", "env", "defaults", "concurrency", "container", "services",
    "outputs",
}
BLOCK_SCALAR = re.compile(r"^(-\s+)?(?!if:)" + KEY + r":\s*[|>][+-]?\d*\s*$")


def _quoted(line):
    """Return (per-character in-quote flags, whether a quote is left open).

    A quote opens only where a scalar can start, so an apostrophe inside a plain
    word ("don't") is ordinary text.
    """
    flags, quote, prev = [], None, " "
    for char in line:
        if quote:
            flags.append(True)
            if char == quote and not (quote == '"' and prev == "\\"):
                quote = None
        elif char in "\"'" and not (prev.isalnum() or prev == "_"):
            quote = char
            flags.append(True)
        else:
            flags.append(False)
        prev = char
    return flags, quote is not None


def _strip_comment(line):
    flags, _ = _quoted(line)
    for index, char in enumerate(line):
        if char == "#" and not flags[index] and (index == 0 or line[index - 1].isspace()):
            return line[:index].strip()
    return line


def _mask(line):
    """Line with quoted spans and ${{ }} expressions removed."""
    flags, _ = _quoted(line)
    plain = "".join(char for char, inside in zip(line, flags) if not inside)
    return re.sub(r"\$\{\{.*?\}\}", "", plain)


def _has_unreadable_escape(span):
    """True for a backslash escape other than \\" and \\\\ (they are compared as literal text)."""
    index = 0
    while index < len(span):
        if span[index] == "\\":
            if index + 1 >= len(span) or span[index + 1] not in '"\\':
                return True
            index += 1
        index += 1
    return False


def unsupported(text):
    """Report constructs outside the supported YAML subset (fail closed)."""
    problems = []
    entries = _marked_structure(text)
    for line in _trigger_scan(text)[1]:
        problems.append(f"unsupported workflow syntax: {line} (unrecognized trigger entry)")
    for position, (indent, line, is_condition) in enumerate(entries):
        if is_condition:
            continue  # continuation text of a multi-line scalar
        if line == "---" and position == 0:
            continue
        if line in ("---", "...") or line.startswith(("--- ", "... ")):
            problems.append("unsupported workflow syntax: multiple documents")
            continue
        body = re.sub(r"^(?:-\s+)+", "", line)
        match = KEY_VALUE.match(body)
        key, value = (match.group(1), (match.group(2) or "").strip()) if match else (None, body)
        if key in ("run", "script"):
            continue  # shell/script text, not workflow structure
        # Keys that drive a rule must be single-line inline scalars; a value on
        # the next line, folded, or spread across lines would be read as empty.
        if key in SCALAR_REQUIRED_KEYS and (not value or value[0] in "|>"):
            problems.append(f"unsupported workflow syntax: {line} (multi-line or folded {key} value)")
            continue
        if key in SCALAR_INLINE_KEYS and value[:1] in ("|", ">"):
            problems.append(f"unsupported workflow syntax: {line} (folded {key} value)")
            continue
        key_indent = indent + len(line) - len(body)
        continues = position + 1 < len(entries) and entries[position + 1][0] > key_indent
        if key in SCALAR_REQUIRED_KEYS | SCALAR_INLINE_KEYS and value and (
            continues or value.count("${{") != value.count("}}")
        ) and not value.startswith("["):
            problems.append(f"unsupported workflow syntax: {line} (value continues on another line)")
            continue
        context = f"unsupported workflow syntax: {line}"
        flags = _quoted(line)[0]
        spans, current = [], ""
        for char, inside in zip(line, flags):
            if inside:
                current += char
            elif current:
                spans.append(current)
                current = ""
        spans.append(current)
        for span in spans:
            if span.startswith('"') and _has_unreadable_escape(span) and (
                key is None or key in RULE_KEYS or "${{" in span
            ):
                problems.append(context + " (unsupported escape in a quoted scalar)")
                break
        if _quoted(line)[1]:
            problems.append(context + " (multi-line quoted scalar)")
        masked = _mask(line)
        if body.startswith("? ") or re.match(r"(?:-\s+)*<<:", line):
            problems.append(context + " (complex or merge key)")
        elif value.startswith(("&", "*", "!")) or (
            value.startswith("[")
            and any(item.strip().startswith(("&", "*", "!")) for item in value[1:].rstrip("]").split(","))
        ):
            # Indicators only mean anchor/alias/tag where a value starts; `a *b`
            # inside a plain scalar (a step name, a glob) is ordinary text.
            problems.append(context + " (anchor, alias or tag)")
        elif value.startswith("{"):
            if not (key == "permissions" and value == "{}"):
                problems.append(context + " (flow mapping)")
        elif value.startswith("["):
            flat = masked.count("[") == 1 and masked.count("]") == 1 and "{" not in masked
            if key is None or key in FLOW_SEQUENCE_FORBIDDEN_KEYS or not value.endswith("]") or not flat:
                problems.append(context + " (flow sequence)")
    return problems


def scan(text):
    """Return (indent, line, in_body) for each meaningful line.

    Structural lines have comments removed. Bodies of every `|`/`>` block
    scalar except `if:` (run, script, path, body, JSON inputs, ...) are kept
    (flagged in_body) because `${{ }}` expressions there are evaluated, but they
    are never read as workflow keys. Continuation lines of an `if:` condition
    (folded, literal or plain multi-line) and continuation lines of any other
    plain multi-line scalar are flagged "cond": they stay in the structure so
    guard matching and secret sweeps read the whole text, but they are scalar
    text, so value-start syntax checks skip them.
    """
    result = []
    body_indent = None
    cond_indent = None
    cond_all = False
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
        stripped = _strip_comment(stripped)
        if not stripped:
            continue
        if cond_indent is not None:
            # After `if:` every deeper line continues the condition; after another
            # key with an inline plain value, only lines that are not themselves
            # keys or list items continue that scalar.
            looks_structural = re.match(r"-\s|(?:" + KEY + r"|[\"'][^\"']*[\"'])\s*:(?:\s|$)", stripped)
            if indent > cond_indent and (cond_all or not looks_structural):
                result.append((indent, stripped, "cond"))
                continue
            cond_indent = None
        stripped = QUOTED_KEY.sub(lambda m: f"{m.group(1)}{m.group(3)}:", stripped)
        stripped = SPACED_KEY.sub(lambda m: f"{m.group(1)}{m.group(2)}:", stripped)
        stripped = QUOTED_ITEM.sub(lambda m: f"{m.group(1)}{m.group(3)}", stripped)
        result.append((indent, stripped, False))
        condition = re.match(r"((?:-\s+)*)if:(?:\s|$)", stripped)
        block = BLOCK_SCALAR.match(stripped)
        if condition:
            cond_indent, cond_all = indent + len(condition.group(1)), True
        elif not block:
            plain = re.match(r"((?:-\s+)*)" + KEY + r":\s+[^\s\[{|>\"'&*!]", stripped)
            if plain:
                cond_indent, cond_all = indent + len(plain.group(1)), False
        if block:
            body_indent = indent + (len(block.group(1)) if block.group(1) else 0)
    return result


def structure(text):
    return [(indent, line) for indent, line, body in scan(text) if body is not True]


def _marked_structure(text):
    return [(indent, line, body == "cond") for indent, line, body in scan(text) if body is not True]


def _block(entries, index):
    indent = entries[index][0]
    body = []
    for child in entries[index + 1:]:
        if child[0] <= indent:
            break
        body.append(child)
    return body


def _trigger_scan(text):
    """Return (events -> child entries, lines of `on:` that were not understood)."""
    entries = structure(text)
    for index, (indent, line) in enumerate(entries):
        match = re.fullmatch(r"on:\s*(.*)", line)
        if indent != 0 or not match:
            continue
        if match.group(1):
            return {event: [] for event in re.findall(r"[A-Za-z_][\w-]*", match.group(1))}, []
        children = _block(entries, index)
        found, bad = {}, []
        key_indent = children[0][0] if children else 0
        for position, (child_indent, child) in enumerate(children):
            if child_indent < key_indent:
                bad.append(child)
            elif child_indent == key_indent:
                key = re.fullmatch("(?:- )?(" + KEY + r")(?::(?:\s.*)?)?", child)
                if key:
                    found[key.group(1)] = _block(children, position)
                else:
                    bad.append(child)
        return found, bad
    return {}, []


def trigger_blocks(text):
    """Map each event in the top-level `on:` to its child entries."""
    return _trigger_scan(text)[0]


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
                name = re.fullmatch("(" + KEY + "):", child)
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
    """Names listed under workflow_run.workflows (and only there)."""
    block = trigger_blocks(text).get("workflow_run", [])
    for position, (indent, line) in enumerate(block):
        match = re.fullmatch(r"workflows:\s*(.*)", line)
        if not match:
            continue
        inline = re.fullmatch(r"\[(.*)\]", match.group(1).strip())
        if inline:
            items = inline.group(1).split(",")
        elif match.group(1).strip():
            items = [match.group(1)]
        else:
            items = []
            for child_indent, child in block[position + 1:]:
                # A block list may sit at the key's own indent.
                if child_indent < indent or (child_indent == indent and not child.startswith("- ")):
                    break
                if child.startswith("- "):
                    items.append(child[2:])
        return [item.strip().strip("'\"") for item in items if item.strip()]
    return []


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
    names = {}
    for key, text in texts.items():
        names.setdefault(workflow_name(text, key).lower(), []).append(key)
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
                    any(c in reach for c in names.get(name.lower(), [])) or name.lower() not in names
                    for name in sources)
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


def _expression_flags(expression):
    """Per-character flags: True inside a single-quoted expression string."""
    flags, quoted = [], False
    for char in expression:
        if char == "'":
            quoted = not quoted
            flags.append(True)
        else:
            flags.append(quoted)
    return flags


def _wrapped(expression):
    """True when one pair of parentheses encloses the whole expression."""
    if not expression.startswith("(") or not expression.endswith(")"):
        return False
    flags, depth = _expression_flags(expression), 0
    for index, char in enumerate(expression):
        if flags[index]:
            continue
        depth += char == "("
        depth -= char == ")"
        if depth == 0:
            return index == len(expression) - 1
    return False


def condition_terms(condition):
    """Split a job `if:` into its top-level `&&` terms.

    Returns (terms, error). Only a pure conjunction is supported: any `||` (even
    inside parentheses or functions), mixed `${{ }}` wrappers or unbalanced
    parentheses return an error, so a guard cannot sit in one alternative branch.
    """
    text = re.sub(r"\s+", " ", condition).strip()
    block = re.match(r"^[|>][+-]?\d*\s*", text)
    text = text[block.end():] if block else text
    if text[:1] in ("'", '"'):
        # A YAML scalar starting with a quote is a whole quoted scalar (a bare
        # expression cannot start with one). Unwrap it like the YAML loader would.
        quote = text[0]
        if block:
            return [], "quote characters inside a block scalar are literal text"
        inner = text[1:-1]
        if len(text) < 2 or text[-1] != quote:
            return [], "unterminated or partly quoted scalar"
        if quote == '"':
            # One left-to-right pass; only \" and \\ are understood, so no other
            # escape (\x7C, \u007c, \n, ...) can smuggle an operator past the parser.
            chars, index = [], 0
            while index < len(inner):
                char = inner[index]
                if char == "\\":
                    if index + 1 >= len(inner) or inner[index + 1] not in '"\\':
                        return [], "unsupported escape in a quoted scalar"
                    chars.append(inner[index + 1])
                    index += 2
                    continue
                if char == '"':
                    return [], "unterminated or partly quoted scalar"
                chars.append(char)
                index += 1
            inner = "".join(chars)
        else:
            if "'" in inner.replace("''", ""):
                return [], "unterminated or partly quoted scalar"
            inner = inner.replace("''", "'")
        text = inner.strip()
    wrapper = re.fullmatch(r"\$\{\{(.*)\}\}", text)
    expression = wrapper.group(1) if wrapper else text
    if "${{" in expression or "}}" in expression:
        return [], "mixed or repeated ${{ }} wrappers"
    flags = _expression_flags(expression)
    if any(not flags[i] and expression.startswith("||", i) for i in range(len(expression))):
        return [], "contains ||"
    if any(flags) and expression.count("'") % 2:
        return [], "unterminated string"
    depth = 0
    for index, char in enumerate(expression):
        if not flags[index]:
            depth += char == "("
            depth -= char == ")"
            if depth < 0:
                return [], "unbalanced parentheses"
    if depth:
        return [], "unbalanced parentheses"
    terms = []

    def split(piece):
        piece = piece.strip()
        while _wrapped(piece):
            piece = piece[1:-1].strip()
        piece_flags, depth, start, parts = _expression_flags(piece), 0, 0, []
        for index, char in enumerate(piece):
            if piece_flags[index]:
                continue
            depth += char == "("
            depth -= char == ")"
            if depth == 0 and piece.startswith("&&", index):
                parts.append(piece[start:index])
                start = index + 2
        parts.append(piece[start:])
        if len(parts) == 1:
            terms.append(re.sub(r"\s*==\s*", " == ", re.sub(r"\s+", " ", piece)).lower())
        else:
            for part in parts:
                split(part)

    split(expression)
    return terms, None


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
            if value.strip("'\"") not in ("{}", "read-all", "none"):
                problems.append(f"permissions grant more than read: {value}")
            continue
        for _, child in _block(entries, index):
            if not re.fullmatch(r"[a-z-]+:\s*['\"]?(?:read|none)['\"]?", child):
                problems.append(f"permissions grant more than read: {child}")
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
    problems += unsupported(text)
    for event in sorted(events - KNOWN_EVENTS):
        problems.append(f"unsupported workflow syntax: unknown event {event}")
    for event in sorted(events & PRIVILEGED_PR_TRIGGERS):
        problems.append(f"uses privileged pull-request trigger {event}")

    # Universal: immutable actions (local reusable workflows are reviewed in repo).
    for _, line in structural:
        match = re.match(r"(?:-\s+)*uses:\s*(\S+)", line)
        action = match.group(1).strip("'\"") if match else ""
        if match and not action.startswith("./") and not PINNED_ACTION.fullmatch(action):
            problems.append(f"action not pinned to a full commit SHA: {action}")

    # Universal: checkout never persists the token or fetches a PR head. Only
    # the step's own `with:` inputs count, not a same-named key elsewhere.
    for index, (uses_indent, line) in enumerate(structural):
        if not re.match(r"(?:-\s+)*uses:\s*['\"]?actions/checkout@", line, re.I):
            continue
        start = index
        if not line.startswith("- "):
            while start > 0 and not (structural[start][0] < uses_indent and structural[start][1].startswith("- ")):
                start -= 1
        dash_indent, first = structural[start]
        prefix_match = re.match(r"(?:-\s+)+", first)
        if not prefix_match:
            problems.append(f"unsupported workflow syntax: {line} (checkout step outside a steps list)")
            continue
        prefix = prefix_match.group(0)
        step = [(dash_indent + len(prefix), first[len(prefix):])]
        for child_indent, child in structural[start + 1:]:
            if child_indent <= dash_indent:
                break
            step.append((child_indent, child))
        inputs = []
        for position, (property_indent, property_line) in enumerate(step):
            if property_indent == step[0][0] and property_line == "with:":
                nested = _block(step, position)
                inputs = [child for child_indent, child in nested if child_indent == nested[0][0]]
                break
        if not any(re.fullmatch(r"persist-credentials:\s*['\"]?false['\"]?", item, re.I) for item in inputs):
            problems.append("checkout does not disable persist-credentials in its with: inputs")
        for item in inputs:
            ref_match = re.fullmatch(r"ref:\s*(.+)", item)
            if not ref_match:
                continue
            ref = ref_match.group(1)
            if UNTRUSTED_REF.search(ref):
                problems.append(f"checkout of untrusted pull-request ref: {ref}")
            elif "github.event.workflow_run" in ref.lower() and ref.strip("${}'\" ").lower() != "github.event.workflow_run.head_sha":
                problems.append(f"checkout of unreviewed workflow_run ref: {ref}")
            elif "workflow_run" in ref.lower() and "workflow_run" not in events:
                problems.append(f"workflow_run ref without workflow_run trigger: {ref}")

    for indent, line in structural:
        match = KEY_VALUE.match(line)
        if indent == 0 and match and match.group(1) not in TOP_KEYS:
            problems.append(f"unsupported workflow syntax: unknown top-level key {match.group(1)}")
    for name, indent, body in jobs(text):
        for child_indent, line in body:
            match = KEY_VALUE.match(line)
            if child_indent == indent and match and match.group(1) not in JOB_KEYS:
                problems.append(f"unsupported workflow syntax: unknown key {match.group(1)} in job {name}")
    if not any(True for _ in jobs(text)):
        problems.append("no jobs could be parsed (job-level checks would be skipped)")

    if not reachable:
        return problems

    # Strict: nothing a pull request can run may hold privilege.
    problems += _permission_problems(text)
    # Only `${{ }}` expressions reference secrets; step names and quoted literals
    # that merely mention the word do not. Run bodies are included because their
    # expressions are evaluated before the shell sees them.
    expressions = re.findall(r"\$\{\{(.*?)\}\}", "\n".join(line for _, line, _ in entries), re.S)
    # `if:` values are expressions even without ${{ }}.
    for position, (indent, line) in enumerate(structural):
        match = re.match(r"((?:-\s+)*)if:\s*(.*)", line)
        if match:
            expressions.append(match.group(2))
            # The key sits after any `- ` prefix; the rest of a folded or plain
            # multi-line condition is indented deeper, siblings are not.
            key_indent = indent + len(match.group(1))
            for child_indent, child in structural[position + 1:]:
                if child_indent <= key_indent:
                    break
                expressions.append(child)
    for expression in expressions:
        if SECRET_REFERENCE.search(re.sub(r"'[^']*'", "''", expression)):
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
            terms, error = condition_terms(_property(body, indent, "if") or "")
            if error:
                problems.append(f"job {name} workflow_run condition is not a supported pure conjunction: {error}")
            else:
                for guard in WORKFLOW_RUN_GUARDS:
                    if guard.lower() not in terms:
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

    def test_quoted_keys_are_read_like_unquoted_keys(self):
        self.rejected(lambda t: t.replace("  pull_request:\n", '  "pull_request_target":\n'), "pull_request_target")
        self.rejected(lambda t: t.replace("on:\n", '"on":\n').replace("  pull_request:\n", "  'issue_comment':\n"), "issue_comment")
        # A quoted PR trigger still makes a deploy-style workflow PR-reachable.
        quoted = DEPLOY.replace("  push:\n    branches: [main]", '  "pull_request":')
        problems = audit(quoted)
        for expected in ("permissions", "secret other than GITHUB_TOKEN", "deployment environment"):
            self.assertTrue(any(expected in problem for problem in problems), (expected, problems))
        self.rejected(lambda t: t.replace("permissions:\n  contents: read", '"permissions":\n  contents: write'), "permissions")
        self.rejected(lambda t: t.replace("    steps:", '    "environment": prod\n    steps:'), "environment")
        self.rejected(lambda t: t.replace("persist-credentials", '"persist-credentials"').replace(
            ": false", ": true"), "persist-credentials")
        self.assertEqual(audit(GOOD.replace("permissions:", '"permissions":').replace("  checks:", '  "checks":')), [])

    def test_comments_are_stripped_outside_quotes_only(self):
        self.assertEqual(audit(GOOD.replace("on:\n", "on:  # don't edit\n")), [])
        self.assertEqual(triggers(GOOD.replace("on:\n", "on:  # don't edit\n")), {"pull_request", "push"})
        self.rejected(lambda t: t.replace("on:\n  pull_request:", "on:  # don't edit\n  pull_request_target:"), "pull_request_target")
        self.assertEqual(audit(GOOD.replace("runs-on: ubuntu-latest", "runs-on: ubuntu-latest # don't change")), [])
        self.assertEqual(audit(GOOD.replace("runs-on: ubuntu-latest", "runs-on: ubuntu-latest # it's fine")), [])
        # A hash inside quotes is data, not a comment, so the runner stays disallowed.
        self.rejected(lambda t: t.replace("runs-on: ubuntu-latest", "runs-on: 'ubuntu-latest # self-hosted'"), "allowlisted GitHub-hosted")
        self.rejected(lambda t: t.replace("contents: read", "contents: read # ok\n  contents2: write"), "permissions")
        self.assertEqual(scan("a: 'x # y'  # z\n")[0][1], "a: 'x # y'")

    def test_checkout_and_action_names_are_case_insensitive(self):
        mixed = GOOD.replace("actions/checkout", "Actions/Checkout")
        self.assertEqual(audit(mixed), [])
        self.rejected(lambda t: mixed.replace("persist-credentials: false", "persist-credentials: true"), "persist-credentials", GOOD)
        self.rejected(lambda t: mixed.replace("        with:\n          persist-credentials: false\n", ""), "persist-credentials", GOOD)
        self.rejected(lambda t: t.replace("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "ACTIONS/CHECKOUT@v4"), "not pinned")

    def test_top_level_read_only_permission_scopes_are_accepted(self):
        self.assertEqual(audit(GOOD.replace("  contents: read\n", "  contents: read\n  packages: read\n")), [])
        self.rejected(lambda t: t.replace("  contents: read\n", "  contents: read\n  packages: write\n"), "permissions")

    def test_unsupported_syntax_fails_closed(self):
        cases = {
            "flow-style step": lambda t: t.replace(
                "      - run:", "      - {uses: actions/setup-node@v4}\n      - run:"),
            "flow-style step list": lambda t: t.replace("    steps:\n", "    steps: [{run: echo}]\n"),
            "flow-style jobs": lambda t: t.replace("jobs:\n", "jobs: {checks: {runs-on: ubuntu-latest}}\n#"),
            "flow-style permissions": lambda t: t.replace("permissions:\n  contents: read", "permissions: {contents: write}"),
            "flow-style on": lambda t: t.replace("on:\n  pull_request:\n  push:\n    branches: [main]", "on: {pull_request_target: {}}"),
            "flow-style uses": lambda t: t.replace("      - run:", "      - uses: [actions/setup-node]\n      - run:"),
            "nested flow sequence": lambda t: t.replace("branches: [main]", "branches: [[main]]"),
            "flow sequence item": lambda t: t.replace("      - run:", "      - [a, b]\n      - run:"),
            "multi-line flow sequence": lambda t: t.replace("branches: [main]", "branches: [main,\n      dev]"),
            "anchor": lambda t: t.replace("  contents: read", "  contents: &perm read"),
            "alias": lambda t: t.replace("  checks:", "  checks: *shared\n  other:"),
            "merge key": lambda t: t.replace("    runs-on: ubuntu-latest", "    <<: *base\n    runs-on: ubuntu-latest"),
            "tag": lambda t: t.replace("  contents: read", "  contents: !!str read"),
            "complex key": lambda t: t.replace("  pull_request:", "  ? pull_request"),
            "multi-document": lambda t: t + "---\non: pull_request_target\n",
            "multi-line quoted scalar": lambda t: t.replace("      - run:", "      - name: 'start\n      - run:"),
            "unknown event": lambda t: t.replace("  pull_request:\n", "  pull_requests:\n"),
            "event case": lambda t: t.replace("  pull_request:\n", "  Pull_Request_Target:\n"),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                self.rejected(mutate, "unsupported workflow syntax")

    def test_supported_simple_syntax_is_not_flagged(self):
        self.assertEqual(unsupported("---\n" + GOOD), [])
        for text in (
            GOOD.replace("branches: [main]", "branches: [main, 'release/*']"),
            GOOD.replace("on:\n  pull_request:\n  push:\n    branches: [main]", "on: [pull_request, push]"),
            GOOD.replace("permissions:\n  contents: read", "permissions: {}"),
            GOOD.replace("      - run:", "      - run: echo {a} && ls *.txt\n      - run:"),
            GOOD.replace("      - run:", "      - run: |\n          echo {x: [1]} *glob &bg\n      - run:"),
            GOOD.replace("      - run:", "      - name: Don't {panic} [yet]\n        run: true\n      - run:"),
        ):
            self.assertEqual(audit(text), [], text)

    def test_github_resolved_names_are_matched_case_insensitively(self):
        env = "      - run: deploy\n        env:\n          X: %s\n"
        for expression in (
            "${{ SECRETS.X }}", "${{ Secrets.X }}", "${{ toJSON(SECRETS) }}",
            "${{ SECRETS['X'] }}", "${{ secrets.GITHUB_TOKEN_EXTRA }}",
        ):
            self.rejected(lambda t, e=expression: t + env % e, "secret other than GITHUB_TOKEN")
        self.rejected(lambda t: t + "      - if: secrets.DEPLOY_KEY != ''\n        run: deploy\n", "secret other than GITHUB_TOKEN")
        self.rejected(lambda t: t + "      - if: >-\n          SECRETS.DEPLOY_KEY != ''\n        run: deploy\n", "secret other than GITHUB_TOKEN")
        for expression in ("${{ secrets.github_token }}", "${{ SECRETS.GITHUB_TOKEN }}", "${{ Secrets.Github_Token }}"):
            self.assertEqual(audit(GOOD + env % expression), [], expression)
        for ref in ("${{ GITHUB.HEAD_REF }}", "${{ Github.Event.Pull_Request.Head.Sha }}"):
            self.rejected(lambda t, r=ref: t.replace(
                "          persist-credentials: false\n", f"          persist-credentials: false\n          ref: {r}\n"),
                "untrusted pull-request ref")
        self.rejected(lambda t: t.replace("          persist-credentials: false\n",
                                          "          persist-credentials: false\n          ref: ${{ GitHub.Event.Workflow_Run.Head_Repository.Ref }}\n"),
                      "workflow_run ref")
        # Guards compare case-insensitively, as Actions expressions do.
        shouting = RUN_GOOD.replace("github.event.workflow_run.event == 'push'", "GITHUB.EVENT.WORKFLOW_RUN.EVENT == 'push'")
        self.assertEqual(audit(shouting), [])
        self.rejected(lambda t: RUN_GOOD.replace("github.event.workflow_run.event == 'push'", "GITHUB.EVENT.WORKFLOW_RUN.EVENT == 'pull_request'"),
                      "lacks workflow_run guard", RUN_GOOD)
        self.assertEqual(audit(RUN_GOOD.replace("ref: ${{ github.event.workflow_run.head_sha }}", "ref: ${{ GITHUB.EVENT.WORKFLOW_RUN.HEAD_SHA }}")), [])
        # Booleans, runner labels and workflow names are case-insensitive too.
        for value in ("False", "FALSE", "'false'"):
            self.assertEqual(audit(GOOD.replace("persist-credentials: false", f"persist-credentials: {value}")), [], value)
        self.rejected(lambda t: t.replace("persist-credentials: false", "persist-credentials: TRUE"), "persist-credentials")
        self.assertEqual(audit(GOOD.replace("ubuntu-latest", "Ubuntu-Latest")), [])
        self.rejected(lambda t: t.replace("ubuntu-latest", "SELF-HOSTED"), "allowlisted GitHub-hosted")
        chained = audit_all({"good.yml": GOOD, "run.yml": RUN_GOOD.replace("[Fixture]", "[FIXTURE]").replace("name: Follow", "name: FOLLOW")})
        self.assertEqual(chained["run.yml"], [])
        deploy_follower = DEPLOY.replace("  push:\n    branches: [main]",
                                         "  workflow_run:\n    workflows: [fixture]\n    types: [completed]\n    branches: [main]")
        self.assertTrue(audit_all({"good.yml": GOOD, "deploy.yml": deploy_follower})["deploy.yml"])
        # Miscased structural keys are never silently skipped.
        self.rejected(lambda t: t.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    Environment: prod\n"), "unknown key Environment")
        self.rejected(lambda t: t + "Permissions:\n  contents: write\n", "unknown top-level key Permissions")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read", "permissions:\n  Contents: write"), "permissions")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read", "permissions:\n  contents: Write"), "permissions")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read", "PERMISSIONS:\n  contents: read"), "unknown top-level key")

    def test_workflow_run_sources_come_only_from_the_workflows_list(self):
        follower = (
            "name: Follow\n\non:\n  workflow_run:\n    workflows:\n      - Deploy\n"
            "    types:\n      - completed\n    branches:\n      - main\n\n"
            "permissions:\n  contents: read\n\njobs:\n  follow:\n    runs-on: ubuntu-latest\n"
            "    if: >-\n      ${{ github.event.workflow_run.event == 'push' &&\n"
            "          github.event.workflow_run.head_branch == 'main' &&\n"
            "          github.event.workflow_run.head_repository.full_name == github.repository }}\n"
            "    steps:\n      - run: echo ok\n"
        )
        self.assertEqual(run_sources(follower), ["Deploy"])
        self.assertEqual(run_sources(follower.replace("      - Deploy\n", "      - Deploy\n      - Other\n")), ["Deploy", "Other"])
        flush = follower.replace("      - Deploy", "    - Deploy")
        self.assertEqual(run_sources(flush), ["Deploy"])
        results = audit_all({"deploy.yml": DEPLOY, "follow.yml": follower})
        self.assertEqual(results, {"deploy.yml": [], "follow.yml": []})
        # The same follower after a PR-triggered workflow is PR-reachable.
        pr_deploy = DEPLOY.replace("  push:\n    branches: [main]", "  pull_request:")
        self.assertTrue(audit_all({"deploy.yml": pr_deploy, "follow.yml": follower.replace(
            "    steps:\n      - run: echo ok\n", "    environment: prod\n    steps:\n      - run: echo ok\n")})["follow.yml"])

    def test_ordinary_simple_flow_sequences_are_supported(self):
        for text in (
            GOOD.replace("branches: [main]", "branches: [main]\n    paths-ignore: ['docs/**']"),
            GOOD.replace("branches: [main]", "branches-ignore: [dev]"),
            GOOD.replace("branches: [main]", "tags: ['v*']\n    tags-ignore: [old]"),
            GOOD.replace("    steps:", "    strategy:\n      matrix:\n        python: ['3.12', '3.13']\n    steps:"),
            GOOD.replace("        with:\n", "        with:\n          sparse-checkout: [scripts, tests]\n"),
            GOOD.replace("    steps:", "    needs: [a, b]\n    steps:"),
        ):
            self.assertEqual(audit(text), [], text)
        # Structure-bearing keys must stay block style.
        for text in (
            GOOD.replace("    steps:\n", "    steps: [a]\n"),
            GOOD.replace("permissions:\n  contents: read", "permissions: [contents]"),
            GOOD.replace("    steps:", "    strategy: [a]\n    steps:"),
            GOOD.replace("        with:\n", "        with: [a]\n"),
            GOOD.replace("      - run:", "      - uses: [a]\n      - run:"),
        ):
            self.assertTrue(any("unsupported workflow syntax" in problem for problem in audit(text)), text)

    def test_permission_values_ignore_quoting_and_spacing(self):
        for line in ("contents: 'read'", 'contents: "read"', "contents:  read", "contents:   none"):
            self.assertEqual(audit(GOOD.replace("contents: read", line)), [], line)
        self.assertEqual(audit(GOOD.replace("permissions:\n  contents: read", "permissions: 'read-all'")), [])
        self.rejected(lambda t: t.replace("contents: read", "contents: 'write'"), "permissions")
        self.rejected(lambda t: t.replace("contents: read", "contents:  write"), "permissions")
        self.rejected(lambda t: t.replace("permissions:\n  contents: read", "permissions: 'write-all'"), "permissions")

    def test_quoted_and_spaced_trigger_spellings_are_read_or_rejected(self):
        trigger = "on:\n  pull_request:\n  push:\n    branches: [main]"
        for spelling in (
            'on:\n  - push\n  - "pull_request_target"',
            "on:\n  - push\n  - 'pull_request_target'",
            'on:\n  "pull_request_target" :\n  push:',
            "on:\n  'pull_request_target':\n  push:",
            "on:\n  pull_request_target :\n  push:",
            '"on":\n  - "pull_request_target"',
        ):
            self.rejected(lambda t, x=spelling: t.replace(trigger, x), "pull_request_target")
        # Quoted spellings still make a deploy-style workflow PR-reachable.
        for spelling in (
            'on:\n  - push\n  - "pull_request"',
            "on:\n  - 'pull_request'",
            'on:\n  - "workflow_call"',
            'on:\n  "pull_request" :',
            "on:\n  pull_request :",
        ):
            deploy = DEPLOY.replace("on:\n  push:\n    branches: [main]", spelling)
            self.assertNotEqual(deploy, DEPLOY)
            for label, problems in (("audit", audit(deploy)), ("audit_all", audit_all({"d.yml": deploy})["d.yml"])):
                for expected in ("permissions", "secret other than GITHUB_TOKEN", "deployment environment"):
                    self.assertTrue(any(expected in problem for problem in problems), (spelling, label, problems))
            self.assertTrue(triggers(deploy) & {"pull_request", "workflow_call"}, spelling)
        self.assertEqual(triggers(GOOD.replace(trigger, 'on:\n  - "push"\n  - \'pull_request\'')), {"push", "pull_request"})
        self.assertEqual(audit(GOOD.replace(trigger, 'on:\n  - "push"\n  - \'pull_request\'')), [])

    def test_unreadable_trigger_entries_fail_closed(self):
        for entry in (
            "  not a trigger entry",
            "  push: [main]\n  weird thing: here",
            "  - push\n  - !!str pull_request_target",
            "  push:\n pull_request_target:",
        ):
            text = GOOD.replace("  pull_request:\n  push:\n    branches: [main]", entry)
            self.assertNotEqual(text, GOOD)
            self.assertTrue(
                any("unsupported workflow syntax" in problem for problem in audit(text)), (entry, audit(text)))

    def test_quoted_uses_values_are_normalized(self):
        sha = "3d3c42e5aac5ba805825da76410c181273ba90b1"
        for quote in ("'", '"'):
            quoted = GOOD.replace(f"actions/checkout@{sha}", f"{quote}actions/checkout@{sha}{quote}")
            self.assertEqual(audit(quoted), [], quote)
            self.rejected(lambda t, q=quoted: q.replace("persist-credentials: false", "persist-credentials: true"), "persist-credentials")
            self.rejected(lambda t, q=quoted: q.replace(
                "          persist-credentials: false\n",
                "          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}\n"),
                "untrusted pull-request ref")
            self.rejected(lambda t, q=quoted: q.replace("@" + sha, "@v4"), "not pinned")
            self.rejected(lambda t, q=quoted: q.replace("        with:\n          persist-credentials: false\n", ""), "persist-credentials")
        self.assertEqual(audit(GOOD.replace(f"@{sha}", f"@{sha} # v7")), [])
        self.assertEqual(audit(GOOD.replace("jobs:\n", "jobs:\n  local:\n    uses: './.github/workflows/x.yml'\n")), [])
        self.rejected(lambda t: t.replace("jobs:\n", "jobs:\n  remote:\n    uses: 'org/repo/.github/workflows/x.yml@main'\n"), "not pinned")
        caller = GOOD.replace("jobs:\n", "jobs:\n  call:\n    uses: './.github/workflows/callee.yml'\n")
        callee = DEPLOY.replace("  push:\n    branches: [main]", "  workflow_call:")
        self.assertTrue(audit_all({"caller.yml": caller, "callee.yml": callee})["callee.yml"])

    def test_scalar_reads_handle_quoted_forms_or_fail_closed(self):
        """Every place a scalar or key is read accepts quoted spellings."""
        self.assertEqual(audit(GOOD.replace("runs-on: ubuntu-latest", "runs-on: 'ubuntu-latest'")), [])
        self.assertEqual(audit(GOOD.replace("runs-on: ubuntu-latest", 'runs-on:\n      - "ubuntu-latest"')), [])
        self.rejected(lambda t: t.replace("runs-on: ubuntu-latest", "runs-on:\n      - 'self-hosted'"), "allowlisted GitHub-hosted")
        self.rejected(lambda t: t.replace("runs-on: ubuntu-latest", '"runs-on" : "self-hosted"'), "allowlisted GitHub-hosted")
        self.rejected(lambda t: t.replace("    steps:", '    "environment" : \'prod\'\n    steps:'), "environment")
        self.rejected(lambda t: t.replace("jobs:\n", "jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    \"secrets\": inherit\n"), "passes secrets")
        self.rejected(lambda t: t.replace("    steps:", '    "permissions":\n      "id-token": write\n    steps:'), "permissions")
        self.rejected(lambda t: t + '      - run: x\n        "env":\n          K: ${{ secrets.K }}\n', "secret other than GITHUB_TOKEN")
        self.rejected(lambda t: t.replace("persist-credentials: false", '"persist-credentials": "true"'), "persist-credentials")
        self.assertEqual(audit(GOOD.replace("persist-credentials: false", '"persist-credentials": "false"')), [])
        follower = RUN_GOOD.replace("    branches: [main]\n", "    branches:\n      - 'main'\n").replace(
            "workflows: [Fixture]", "workflows:\n      - 'Fixture'")
        self.assertEqual(audit_all({"good.yml": GOOD, "follow.yml": follower}), {"good.yml": [], "follow.yml": []})
        self.assertEqual(run_sources(follower), ["Fixture"])
        self.rejected(lambda t: follower.replace("'main'", "'main'\n      - 'dev'"), "not limited to branches", RUN_GOOD)
        self.assertEqual(audit(RUN_GOOD.replace(
            "ref: ${{ github.event.workflow_run.head_sha }}", "ref: '${{ github.event.workflow_run.head_sha }}'")), [])
        self.rejected(lambda t: RUN_GOOD.replace(
            "ref: ${{ github.event.workflow_run.head_sha }}", "ref: '${{ github.event.workflow_run.head_ref }}'"),
            "workflow_run ref", RUN_GOOD)
        self.assertEqual(audit(GOOD.replace("  checks:", '  "checks" :')), [])
        self.rejected(lambda t: t.replace("  checks:", '  "checks" :').replace("ubuntu-latest", "self-hosted"), "allowlisted GitHub-hosted")

    def test_checkout_inputs_are_read_only_from_the_steps_with_block(self):
        sha = "3d3c42e5aac5ba805825da76410c181273ba90b1"
        step = f"      - uses: actions/checkout@{sha}\n        with:\n          persist-credentials: false\n"
        self.assertIn(step, GOOD)
        misplaced = f"      - uses: actions/checkout@{sha}\n        env:\n          persist-credentials: false\n"
        self.rejected(lambda t: t.replace(step, misplaced), "persist-credentials")
        # A sibling key does not satisfy the check even beside a real with: block.
        beside = f"{misplaced}        with:\n          fetch-depth: 1\n"
        self.rejected(lambda t: t.replace(step, beside), "persist-credentials")
        before = f"      - uses: actions/checkout@{sha}\n        with:\n          fetch-depth: 1\n        env:\n          persist-credentials: false\n"
        self.rejected(lambda t: t.replace(step, before), "persist-credentials")
        nested = f"      - uses: actions/checkout@{sha}\n        with:\n          sparse:\n            persist-credentials: false\n"
        self.rejected(lambda t: t.replace(step, nested), "persist-credentials")
        self.rejected(lambda t: t.replace(step, f"      - uses: actions/checkout@{sha}\n"), "persist-credentials")
        # The real input in a real with: block, in any position or step layout, passes.
        for ok in (
            f"      - uses: actions/checkout@{sha}\n        with:\n          fetch-depth: 1\n          persist-credentials: false\n",
            f"      - name: Check out\n        env:\n          A: b\n        with:\n          persist-credentials: false\n        uses: actions/checkout@{sha}\n",
            f"      - with:\n          sparse-checkout: [a, b]\n          persist-credentials: 'false'\n        uses: actions/checkout@{sha}\n",
            f"      - with:\n          paths:\n            - a\n          persist-credentials: false\n        uses: actions/checkout@{sha}\n",
        ):
            self.assertEqual(audit(GOOD.replace(step, ok)), [], ok)
        # A with: block that follows another step's list items is still this step's own.
        two = (f"      - uses: actions/checkout@{sha}\n        with:\n          persist-credentials: false\n"
               f"      - uses: actions/checkout@{sha}\n        with:\n          fetch-depth: 1\n")
        self.rejected(lambda t: t.replace(step, two), "persist-credentials")
        # ref: counts only as a with: input; elsewhere it is not a checkout ref.
        head = "${{ github.event.pull_request.head.sha }}"
        self.rejected(lambda t: t.replace(step, step + f"          ref: {head}\n"), "untrusted pull-request ref")
        self.rejected(lambda t: t.replace(step, step.replace("          persist", f"          ref: {head}\n          persist")), "untrusted pull-request ref")
        self.assertEqual(audit(GOOD.replace(step, step.replace("        with:", f"        env:\n          ref: {head}\n        with:"))), [])
        # Text that merely mentions a checkout is not a checkout step.
        self.assertEqual(audit(GOOD.replace("      - run:", f"      - run: echo uses: actions/checkout@{sha}\n      - run:")), [])

    def test_quoted_globs_are_data_not_anchors_or_flow_syntax(self):
        trigger = "  pull_request:\n"
        for item in ("'*test*'", "'*-docs'", '"**/*.md"', "'&name'", "'!ignored'", "'[abc]'", "'{a,b}'", "'a: b'", "'# note'", "'- x'"):
            for key in ("paths", "paths-ignore", "branches"):
                text = GOOD.replace(trigger, f"{trigger}    {key}:\n      - {item}\n")
                self.assertEqual(unsupported(text), [], (key, item))
                self.assertEqual(audit(text), [], (key, item))
        # Plain content is still unquoted so triggers and labels are read consistently.
        self.assertEqual(scan("on:\n  - 'push'\n")[1][1], "- push")
        self.assertEqual(scan("a:\n  - '*x*'\n")[1][1], "- '*x*'")
        # Real anchors, aliases and tags are still rejected, quoted or not elsewhere.
        for line in ("      - *test", "      - &test x", "      - !!str x", "      - key: *alias", "      - key: &anchor x"):
            self.rejected(lambda t, l=line: t.replace("      - run:", f"{l}\n      - run:"), "unsupported workflow syntax")

    def test_job_keys_must_be_real_github_actions_keys(self):
        self.rejected(lambda t: t.replace("    runs-on:", "    snapshot: image\n    runs-on:"), "unknown key snapshot")

    def test_block_scalar_bodies_are_data_for_any_key_but_if(self):
        upload = (
            "      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9\n"
            "        with:\n          name: report\n          path: |\n            playwright-report/\n"
        )
        base = GOOD + upload
        self.assertEqual(audit(base), [])
        # Ordinary edit: a negated path pattern in the multi-line input.
        self.assertEqual(audit(base + "            !playwright-report/trace/**\n"), [])
        self.assertEqual(audit(base + "            *.log\n            &odd\n"), [])
        # JSON inside a block scalar on env:/with: is not a flow mapping.
        self.assertEqual(audit(GOOD + "      - run: x\n        env:\n          CONFIG: |\n            {\"a\": [1, {\"b\": 2}]}\n"), [])
        self.assertEqual(audit(GOOD + "      - run: x\n        env:\n          CONFIG: >-\n            {a: [1]}\n"), [])
        # YAML-looking text in a text input is neither structure nor a finding.
        looks_like_yaml = (
            "      - uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea\n"
            "        with:\n          body: |\n            permissions:\n              contents: write\n"
            "            uses: actions/checkout@v4\n            environment: prod\n            runs-on: self-hosted\n"
            "            - *anchor\n            on: pull_request_target\n"
        )
        self.assertEqual(audit(GOOD + looks_like_yaml), [])
        self.assertEqual(audit_all({"a.yml": DEPLOY + looks_like_yaml.replace("          body", "          body")}), {"a.yml": []})
        # Expressions inside any block scalar are still evaluated, so secrets are caught.
        self.rejected(lambda t: t + upload + "            ${{ secrets.DEPLOY_KEY }}\n", "secret other than GITHUB_TOKEN")
        self.rejected(lambda t: t + looks_like_yaml + "            token ${{ SECRETS.X }}\n", "secret other than GITHUB_TOKEN")
        # The body ends at the next key, which is read as structure again.
        self.rejected(lambda t: t + upload + "          environment: [a]\n", "unsupported workflow syntax")
        # if: stays an expression, never data.
        self.rejected(lambda t: t + "      - if: >-\n          secrets.A != ''\n        run: x\n", "secret other than GITHUB_TOKEN")

    def test_if_continuations_are_scanned_only_for_block_scalar_conditions(self):
        for step in (
            "      - if: always()\n        name: secrets-report\n        run: npm run lint:secrets\n",
            "      - if: always()\n        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9\n        with:\n          name: secrets-report\n",
            "      - if: failure() && github.event_name == 'pull_request'\n        name: Report on secrets handling\n        run: echo ok\n",
            "      - if: >-\n          github.event_name == 'push'\n        name: secrets report\n        run: echo ok\n",
        ):
            self.assertEqual(audit(GOOD + step), [], step)
        for step in (
            "      - if: secrets.A != ''\n        run: x\n",
            "      - if: ${{ secrets.A }}\n        run: x\n",
            "      - if: >-\n          secrets.A != ''\n        run: x\n",
            "      - if: |\n          SECRETS.A\n        run: x\n",
            "      - if: always()\n        run: x\n        env:\n          K: ${{ secrets.A }}\n",
        ):
            self.rejected(lambda t, x=step: t + x, "secret other than GITHUB_TOKEN")

    def test_checkout_outside_a_steps_list_fails_closed_without_crashing(self):
        sha = "3d3c42e5aac5ba805825da76410c181273ba90b1"
        job_level = GOOD.replace("    steps:\n", f"    uses: actions/checkout@{sha}\n    steps:\n")
        self.rejected(lambda t: job_level, "checkout step outside a steps list")
        top_level = GOOD + f"uses: actions/checkout@{sha}\n"
        self.rejected(lambda t: top_level, "checkout step outside a steps list")
        self.assertTrue(audit_all({"a.yml": job_level})["a.yml"])

    def test_anchor_sigils_matter_only_at_the_start_of_a_value(self):
        for text in (
            GOOD.replace("      - run:", "      - name: Fix *foo and Q&A *all*\n        run: true\n      - run:"),
            GOOD.replace("      - run:", "      - run: true\n        env:\n          URL: https://x.example/?a=1&b=2\n          NOTE: use *stars* & ampersands\n      - run:"),
            GOOD.replace("  pull_request:\n", "  schedule:\n    - cron: 0 0 * * *\n    - cron: '*/15 * * * *'\n  pull_request:\n"),
            GOOD.replace("      - run:", "      - if: ${{ !cancelled() }}\n        run: true\n      - run:"),
        ):
            self.assertEqual(audit(text), [], text)
        for text in (
            GOOD.replace("branches: [main]", "branches: [*main]"),
            GOOD.replace("branches: [main]", "branches: [main, &x dev]".replace("&x dev", "&x")),
            GOOD.replace("branches: [main]", "branches: [!!str main]"),
            GOOD.replace("contents: read", "contents: &r read"),
            GOOD.replace("      - run:", "      - &s run: x\n      - run:"),
            GOOD.replace("      - run:", "      - name: *n\n      - run:"),
        ):
            self.assertTrue(any("unsupported workflow syntax" in p for p in audit(text)), text)

    def test_realistic_ordinary_edits_do_not_fail(self):
        edits = {
            "matrix": "    strategy:\n      fail-fast: false\n      matrix:\n        python: ['3.11', '3.12']\n        node: [20, 22]\n        include:\n          - python: '3.12'\n            node: 22\n",
            "defaults and timeout": "    timeout-minutes: 10\n    defaults:\n      run:\n        shell: bash\n    continue-on-error: false\n",
            "services": "    services:\n      db:\n        image: postgres:17\n        ports: ['5432:5432']\n        options: >-\n          --health-cmd pg_isready\n          --health-retries 10\n",
        }
        for label, block in edits.items():
            self.assertEqual(audit(GOOD.replace("    steps:", block + "    steps:")), [], label)
        top = GOOD.replace("permissions:\n  contents: read\n", "permissions:\n  contents: read\n\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\nenv:\n  CI: true\n")
        self.assertEqual(audit(top), [])
        filters = GOOD.replace("  pull_request:\n", "  pull_request:\n    paths:\n      - 'src/**'\n      - '!docs/**'\n      - \"*.md\"\n    paths-ignore: ['docs/**']\n")
        self.assertEqual(audit(filters), [])
        self.assertEqual(audit(GOOD.replace("on:\n", "on:  # Don't touch 'this'\n").replace(
            "      - run:", "      # it's a \"comment\" about secrets: write\n      - run:")), [])
        self.assertEqual(audit(GOOD + "      - run: >-\n          npm test\n          -- --ci\n"), [])
        self.assertEqual(audit(GOOD + "      - run: |\n          for i in {1..3}; do echo ${i}; done\n          echo \"*.txt & !x\"\n"), [])

    def test_rule_driving_scalars_must_be_inline_or_fail_closed(self):
        sha = "3d3c42e5aac5ba805825da76410c181273ba90b1"
        step = f"      - uses: actions/checkout@{sha}\n        with:\n          persist-credentials: false\n"
        self.assertIn(step, GOOD)
        head = "${{ github.head_ref }}"
        cases = {
            "uses on the next line": f"      - uses:\n          actions/checkout@v4\n        with:\n          persist-credentials: true\n",
            "pinned uses on the next line": f"      - uses:\n          actions/checkout@{sha}\n        with:\n          persist-credentials: true\n",
            "folded uses": f"      - uses: >-\n          actions/checkout@{sha}\n        with:\n          persist-credentials: true\n",
            "literal uses": f"      - uses: |\n          actions/checkout@{sha}\n        with:\n          persist-credentials: true\n",
            "multi-line plain uses": f"      - uses: actions/checkout@{sha}\n          more\n        with:\n          persist-credentials: true\n",
            "folded ref": step + f"          ref: >-\n            {head}\n",
            "literal ref": step + f"          ref: |\n            {head}\n",
            "ref on the next line": step + f"          ref:\n            {head}\n",
            "multi-line ref expression": step + "          ref: ${{\n            github.head_ref }}\n",
            "plain multi-line ref": step + "          ref: main\n            ${{ github.head_ref }}\n",
            "persist on the next line": step.replace("persist-credentials: false", "persist-credentials:\n            true"),
            "folded persist": step.replace("persist-credentials: false", "persist-credentials: >-\n            true"),
        }
        for label, replacement in cases.items():
            problems = audit(GOOD.replace(step, replacement))
            self.assertTrue(any("unsupported workflow syntax" in problem for problem in problems), (label, problems))
        # The same applies to a workflow_run checkout ref.
        for ref in ("ref: >-\n            ${{ github.event.workflow_run.head_sha }}", "ref:\n            ${{ github.event.workflow_run.head_sha }}"):
            self.rejected(lambda t, r=ref: RUN_GOOD.replace("ref: ${{ github.event.workflow_run.head_sha }}", r),
                          "unsupported workflow syntax", RUN_GOOD)
        for label, mutate in {
            "folded runs-on": lambda t: t.replace("runs-on: ubuntu-latest", "runs-on: >-\n      self-hosted"),
            "runs-on continuation": lambda t: t.replace("runs-on: ubuntu-latest", "runs-on: ubuntu-latest\n      self-hosted"),
            "folded environment": lambda t: t.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: >-\n      prod\n"),
            "folded permission": lambda t: t.replace("contents: read", "contents: >-\n    write"),
            "permission continuation": lambda t: t.replace("contents: read", "contents: read\n    write"),
        }.items():
            self.assertTrue(audit(mutate(GOOD)), label)
        folded_branches = RUN_GOOD.replace("branches: [main]", "branches: >-\n      main")
        self.rejected(lambda t: folded_branches, "not limited to branches", RUN_GOOD)
        self.rejected(lambda t: RUN_GOOD.replace("branches: [main]", "branches:\n      main"), "not limited to branches", RUN_GOOD)
        self.rejected(lambda t: RUN_GOOD.replace("workflows: [Fixture]", "workflows: >-\n      Fixture"), "unsupported workflow syntax", RUN_GOOD)
        # Ordinary inline spellings of the same keys are unaffected.
        for text in (
            GOOD.replace(step, step + "          ref: ${{ github.sha }}\n"),
            GOOD.replace(step, step + "          ref: main\n"),
            GOOD.replace(step, step.replace("actions/checkout@" + sha, "actions/checkout@" + sha + " # v7")),
            GOOD.replace("runs-on: ubuntu-latest", "runs-on:\n      - ubuntu-latest"),
        ):
            self.assertEqual(audit(text), [], text)

    def test_plain_multi_line_if_conditions_are_scanned_for_secrets(self):
        for step in (
            "      - if: github.event_name == 'push' &&\n          secrets.DEPLOY_KEY != ''\n        run: x\n",
            "      - if: always() &&\n          SECRETS.K\n        run: x\n",
            "      - name: x\n        if: always() &&\n          secrets.K\n        run: x\n",
        ):
            self.rejected(lambda t, x=step: t + x, "secret other than GITHUB_TOKEN")
        # Siblings after a single-line condition are not part of it.
        self.assertEqual(audit(GOOD + "      - if: always()\n        name: secrets-report\n        run: echo secrets\n"), [])
        self.assertEqual(audit(GOOD + "      - if: always() &&\n          github.event_name == 'push'\n        name: secrets-report\n        run: x\n"), [])

    def test_shared_workflow_names_are_all_considered_for_reachability(self):
        pr = GOOD.replace("name: Fixture", "name: CI")
        push_only = DEPLOY.replace("name: Deploy", "name: CI")
        follower = DEPLOY.replace(
            "  push:\n    branches: [main]",
            "  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]",
        ).replace("name: Deploy", "name: Follow")
        for order in (("pr.yml", "push.yml"), ("push.yml", "pr.yml")):
            texts = {key: {"pr.yml": pr, "push.yml": push_only}[key] for key in order}
            texts["follow.yml"] = follower
            self.assertIn("follow.yml", pr_reachable(texts))
            self.assertTrue(audit_all(texts)["follow.yml"])
        # With only push-triggered workflows of that name, the follower is not reachable.
        other = push_only.replace("branches: [main]", "branches: [main, release]")
        results = audit_all({"push.yml": push_only, "other.yml": other, "follow.yml": follower})
        self.assertNotIn("follow.yml", pr_reachable({"push.yml": push_only, "other.yml": other, "follow.yml": follower}))
        self.assertEqual(results["follow.yml"], [])

    def test_multi_line_conditions_are_expression_text_not_yaml_structure(self):
        for label, step in {
            "folded with leading !": "      - if: >-\n          ${{ always() &&\n              !cancelled() }}\n        run: x\n",
            "literal with leading !": "      - if: |\n          !cancelled()\n        run: x\n",
            "folded leading &&": "      - if: >-\n          github.event_name == 'push'\n          && github.ref == 'refs/heads/main'\n        run: x\n",
            "plain leading &&": "      - if: github.event_name == 'push'\n          && github.ref == 'refs/heads/main'\n        run: x\n",
            "plain leading *": "      - if: github.run_number\n          * 2 > 4\n        run: x\n",
            "brackets braces quotes": "      - if: >-\n          contains(fromJSON('[\"a\", \"b\"]'), github.event_name) ||\n          {x}\n        run: x\n",
            "trailing comment": "      - if: >-\n          always() # keep running\n          && true\n        run: x\n",
            "colon in a string": "      - if: >-\n          github.event.label.name == 'a: b'\n        run: x\n",
            "then sibling keys": "      - if: >-\n          !cancelled()\n        name: after\n        run: y\n",
        }.items():
            self.assertEqual(audit(GOOD + step), [], label)
        job_level = GOOD.replace("    runs-on:", "    if: |\n      !cancelled() &&\n      github.event_name != 'schedule'\n    runs-on:")
        self.assertEqual(audit(job_level), [])
        # Other multi-line plain scalars behave the same way.
        for step in (
            "      - name: build ${{ matrix.os }} &&\n          !skipped\n        run: x\n",
            "      - run: x\n        env:\n          NOTE: some text\n            && more text\n",
        ):
            self.assertEqual(audit(GOOD + step), [], step)
        # The full condition still feeds the secret sweeps and the workflow_run guards.
        for step in (
            "      - if: >-\n          !cancelled()\n          && secrets.K != ''\n        run: x\n",
            "      - if: always()\n          && SECRETS.K\n        run: x\n",
            "      - if: >-\n          [x] || ${{ secrets.K }}\n        run: x\n",
        ):
            self.rejected(lambda t, x=step: t + x, "secret other than GITHUB_TOKEN")
        leading = RUN_GOOD.replace(
            "      ${{ github.event.workflow_run.event == 'push' &&\n"
            "          github.event.workflow_run.head_branch == 'main' &&\n"
            "          github.event.workflow_run.head_repository.full_name == github.repository }}",
            "      ${{ github.event.workflow_run.event == 'push'\n"
            "          && github.event.workflow_run.head_branch == 'main'\n"
            "          && !cancelled()\n"
            "          && github.event.workflow_run.head_repository.full_name == github.repository }}",
        )
        self.assertNotEqual(leading, RUN_GOOD)
        self.assertEqual(audit(leading), [])
        self.rejected(lambda t: leading.replace("          && github.event.workflow_run.head_branch == 'main'\n", ""),
                      "lacks workflow_run guard", RUN_GOOD)
        # Real syntax problems on a condition's own line are still reported.
        self.rejected(lambda t: t + "      - if: !cancelled()\n        run: x\n", "unsupported workflow syntax")
        self.rejected(lambda t: t + "      - if: always()\n        run: x\n        uses: [a]\n", "unsupported workflow syntax")

    def test_pull_request_checkout_ref_spellings_are_rejected(self):
        def checkout(ref):
            return lambda t: t.replace("persist-credentials: false", f"persist-credentials: false\n          ref: {ref}")
        for ref in (
            "refs/pull/${{ github.event.number }}/merge",
            "refs/pull/${{ github.event.number }}/head",
            "refs/pull/${{ github.event.pull_request.number }}/head",
            "refs/pull/${{ github.event.issue.number }}/head",
            "refs/pull/12/head", "ref/pull/12/merge", "'refs/pull/1/head'",
            "${{ github.event.pull_request.merge_commit_sha }}",
            "${{ GITHUB.EVENT.NUMBER }}", "${{ Github.Event.Pull_Request.Number }}",
            "${{ github.head_ref }}", "${{ github.event.pull_request.head.ref }}",
        ):
            self.rejected(checkout(ref), "untrusted pull-request ref")
        for ref in ("main", "refs/heads/main", "${{ github.sha }}", "${{ github.ref }}", "refs/tags/v1"):
            self.assertEqual(audit(checkout(ref)(GOOD)), [], ref)
        # The same patterns apply to a workflow_run follower's checkout.
        for ref in (
            "refs/pull/${{ github.event.workflow_run.pull_requests[0].number }}/head",
            "refs/pull/${{ github.event.number }}/merge",
            "${{ github.event.workflow_run.head_branch }}",
        ):
            self.rejected(lambda t, r=ref: RUN_GOOD.replace(
                "ref: ${{ github.event.workflow_run.head_sha }}", f"ref: {r}"), "workflow_run ref" if "head_branch" in ref else "untrusted pull-request ref", RUN_GOOD)

    def run_with(self, expression, layout="inline"):
        """RUN_GOOD with its job condition replaced by `expression`."""
        start = RUN_GOOD.index("    if: >-")
        end = RUN_GOOD.index("    runs-on:")
        if layout == "inline":
            condition = f"    if: ${{{{ {expression} }}}}\n"
        elif layout == "bare":
            condition = f"    if: {expression}\n"
        else:  # folded
            condition = f"    if: >-\n      ${{{{ {expression} }}}}\n"
        return RUN_GOOD[:start] + condition + RUN_GOOD[end:]

    def test_workflow_run_condition_must_be_a_pure_conjunction_of_the_guards(self):
        a = "github.event.workflow_run.event == 'push'"
        b = "github.event.workflow_run.head_branch == 'main'"
        c = "github.event.workflow_run.head_repository.full_name == github.repository"
        for layout in ("inline", "folded", "bare"):
            self.assertEqual(audit(self.run_with(f"{a} && {b} && {c}", layout)), [], layout)
        # Accepted: any order, extra narrowing terms, grouping, leading operators, case.
        for expression in (
            f"{c} && {a} && {b}",
            f"{b} && {c} && {a} && github.event.workflow_run.conclusion == 'success'",
            f"always() && !cancelled() && {a} && {b} && {c}",
            f"({a} && {b}) && {c}",
            f"(({a} && {b} && {c}))",
            f"{a}\n          && {b}\n          && !cancelled()\n          && {c}",
            f"GITHUB.EVENT.WORKFLOW_RUN.EVENT=='push' && {b.upper().replace('MAIN', 'main')} && {c}",
        ):
            self.assertEqual(audit(self.run_with(expression)), [], expression)
        rejected = {
            "or true after the last term": f"{a} && {b} && {c} || true",
            "or true in the expression": f"{a} && {b} && ({c} || true)",
            "alternative push branch": f"{a} && {b} && {c} || github.event_name == 'push'",
            "ternary-like": f"{a} && {b} && {c} || {a}",
            "guards only in the left alternative": f"({a} && {b} && {c}) || {a}",
            "guards only in the right alternative": f"{a} || ({a} && {b} && {c})",
            "partial conjunction alternative": f"({a} && {b} && {c}) || ({a} && {b})",
            "or inside an extra term": f"(github.event_name == 'x' || true) && {a} && {b} && {c}",
            "or inside a function": f"contains(fromJSON('[1]'), 1) && {a} && {b} && {c} || true",
            "negated whole conjunction": f"!({a} && {b} && {c})",
            "negated guard": f"!({a}) && {b} && {c}",
            "inverted comparison": f"github.event.workflow_run.event != 'push' && {b} && {c}",
            "inverted repository": f"{a} && {b} && github.event.workflow_run.head_repository.full_name != github.repository",
            "function wrapper": f"contains({a}, 'x') && {b} && {c}",
            "fromJSON wrapper": f"fromJSON('true') && format('{{0}}', {a}) && {b} && {c}",
            "guard only inside a call": f"toJSON({a} && {b} && {c})",
            "string literal mention": f"'{a} && {b} && {c}'",
            "missing event guard": f"{b} && {c}",
            "missing branch guard": f"{a} && {c}",
            "missing repository guard": f"{a} && {b}",
            "different branch": f"{a} && github.event.workflow_run.head_branch == 'dev' && {c}",
            "no condition at all": "true",
        }
        for label, expression in rejected.items():
            problems = audit(self.run_with(expression))
            self.assertTrue(
                any("workflow_run" in problem and ("guard" in problem or "conjunction" in problem) for problem in problems),
                (label, problems))
        # `||` placed before or after the closing delimiter is equally rejected.
        before = self.run_with(f"{a} && {b} && {c} || true")
        after = self.run_with(f"{a} && {b} && {c}").replace(" }}\n", " }} || true\n", 1)
        self.assertNotEqual(after, self.run_with(f"{a} && {b} && {c}"))
        for text in (before, after):
            self.assertTrue(any("pure conjunction" in problem for problem in audit(text)), text)
        # Folded and leading-operator layouts keep working.
        self.assertEqual(audit(self.run_with(f"{a}\n          && {b}\n          && {c}", "folded")), [])
        # A missing `if:` is missing every guard.
        no_if = RUN_GOOD[:RUN_GOOD.index("    if: >-")] + RUN_GOOD[RUN_GOOD.index("    runs-on:"):]
        self.assertEqual(sum("lacks workflow_run guard" in p for p in audit(no_if)), 3)

    def test_real_prepare_site_condition_is_a_pure_conjunction_and_rejects_boolean_bypasses(self):
        texts = self.texts()
        prepare = texts["prepare-site.yml"]
        self.assertEqual(audit_all(texts)["prepare-site.yml"], [])
        self.assertIn("github.repository }}", prepare)
        for label, mutated in {
            "|| true before the delimiter": prepare.replace("github.repository }}", "github.repository || true }}", 1),
            "|| true after the delimiter": prepare.replace("github.repository }}", "github.repository }} || true", 1),
            "alternative branch": prepare.replace("github.repository }}", "github.repository || github.event_name == 'push' }}", 1),
            "negated repository": prepare.replace("== github.repository }}", "!= github.repository }}", 1),
            "negated conjunction": prepare.replace("${{ github.event.workflow_run.conclusion", "${{ !(github.event.workflow_run.conclusion", 1).replace("github.repository }}", "github.repository) }}", 1),
        }.items():
            self.assertNotEqual(mutated, prepare, label)
            problems = audit_all({**texts, "prepare-site.yml": mutated})["prepare-site.yml"]
            self.assertTrue(problems, label)
        # Reordered, leading-operator and single-line spellings of the real guard pass.
        guard_a = "github.event.workflow_run.event == 'push'"
        reordered = prepare.replace(
            "    if: >-\n      ${{ github.event.workflow_run.conclusion == 'success' &&\n"
            f"          {guard_a} &&\n          github.event.workflow_run.head_branch == 'main' &&\n"
            "          github.event.workflow_run.head_repository.full_name == github.repository }}",
            "    if: >-\n      ${{ github.event.workflow_run.head_repository.full_name == github.repository\n"
            f"          && github.event.workflow_run.head_branch == 'main'\n          && {guard_a}\n"
            "          && github.event.workflow_run.conclusion == 'success' }}",
        )
        self.assertNotEqual(reordered, prepare)
        self.assertEqual(audit_all({**texts, "prepare-site.yml": reordered})["prepare-site.yml"], [])

    def test_review_thread_regressions_on_the_real_workflows(self):
        texts = self.texts()
        runtime, browser, prepare = texts["runtime-ci.yml"], texts["browser-ci.yml"], texts["prepare-site.yml"]

        def broken(name, text):
            return audit_all({**texts, name: text})[name]

        # Local workflow_call edges, including a nested call: the callee is strict.
        pr_caller = "name: Caller\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n"
        callee = (
            "name: Reusable\non:\n  workflow_call:\npermissions:\n  contents: read\njobs:\n  inner:\n"
            "    runs-on: self-hosted\n    steps:\n      - run: echo ok\n"
        )
        nested = callee.replace("    runs-on: self-hosted\n    steps:\n      - run: echo ok\n",
                                "    uses: ./.github/workflows/leaf.yml\n")
        leaf = callee.replace("name: Reusable", "name: Leaf")
        direct = audit_all({"caller.yml": pr_caller, "reusable.yml": callee})
        self.assertTrue(any("self-hosted" in p for p in direct["reusable.yml"]))
        chain = audit_all({"caller.yml": pr_caller, "reusable.yml": nested, "leaf.yml": leaf})
        self.assertTrue(any("self-hosted" in p for p in chain["leaf.yml"]))
        self.assertTrue(any("unresolvable" in p for p in audit_all({"caller.yml": pr_caller})["caller.yml"]))

        # Effective checkout inputs: a name-only marker and a folded PR-head ref fail.
        real_input = "          persist-credentials: false\n"
        self.assertIn(real_input, runtime)
        name_only = runtime.replace(real_input, "", 1).replace(
            "      - uses: actions/checkout@", "      - name: 'x persist-credentials: false'\n        uses: actions/checkout@", 1)
        self.assertNotEqual(name_only, runtime)
        self.assertTrue(any("persist-credentials" in p for p in broken("runtime-ci.yml", name_only)))
        folded_ref = runtime.replace(
            real_input, real_input + "          ref: >-\n            ${{ github.event.pull_request.head.sha }}\n", 1)
        self.assertNotEqual(folded_ref, runtime)
        self.assertTrue(any("unsupported workflow syntax" in p for p in broken("runtime-ci.yml", folded_ref)))
        inline_ref = runtime.replace(real_input, real_input + "          ref: ${{ github.event.pull_request.head.sha }}\n", 1)
        self.assertTrue(any("untrusted pull-request ref" in p for p in broken("runtime-ci.yml", inline_ref)))

        # Quoted structural keys are read like plain ones.
        self.assertIn("  pull_request:\n", runtime)
        self.assertTrue(any("pull_request_target" in p for p in broken(
            "runtime-ci.yml", runtime.replace("  pull_request:\n", '  "pull_request_target":\n', 1))))
        self.assertTrue(any("pull_request_target" in p for p in broken(
            "browser-ci.yml", browser.replace("  pull_request:\n", "  'pull_request_target' :\n", 1))))
        job_write_all = runtime.replace("    runs-on: ubuntu-latest\n", '    "permissions": write-all\n    runs-on: ubuntu-latest\n', 1)
        self.assertNotEqual(job_write_all, runtime)
        self.assertTrue(any("permissions" in p for p in broken("runtime-ci.yml", job_write_all)))

        # Source discovery reads only the workflows list, so inline and block-list
        # spellings of the same push-only chain agree on reachability and results.
        trigger = "  push:\n    branches: [main]"
        inline = DEPLOY.replace(trigger, "  workflow_run:\n    workflows: [Deploy]\n    types: [completed]\n    branches: [main]")
        block = DEPLOY.replace(
            trigger,
            "  workflow_run:\n    workflows:\n      - Deploy\n    types:\n      - completed\n    branches:\n      - main",
        )
        results = []
        for follower in (inline, block):
            follower = follower.replace("name: Deploy", "name: Follow")
            chain = {"deploy.yml": DEPLOY, "follow.yml": follower}
            self.assertEqual(run_sources(follower), ["Deploy"])
            self.assertNotIn("follow.yml", pr_reachable(chain))
            results.append(audit_all(chain))
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0]["follow.yml"], [])

    def test_quoted_whole_scalar_conditions_are_unwrapped_like_yaml_does(self):
        a = "github.event.workflow_run.event == 'push'"
        b = "github.event.workflow_run.head_branch == 'main'"
        c = "github.event.workflow_run.head_repository.full_name == github.repository"
        good = f"{a} && {b} && {c}"

        def quoted(expression, quote):
            start = RUN_GOOD.index("    if: >-")
            end = RUN_GOOD.index("    runs-on:")
            if quote == '"':
                value = '"' + expression.replace('"', '\\"') + '"'
            else:
                value = "'" + expression.replace("'", "''") + "'"
            return RUN_GOOD[:start] + f"    if: {value}\n" + RUN_GOOD[end:]

        for quote in ('"', "'"):
            self.assertEqual(audit(quoted(f"${{{{ {good} }}}}", quote)), [], quote)
            self.assertEqual(audit(quoted(f"${{{{ {c} && {a} && !cancelled() && {b} }}}}", quote)), [], quote)
            # Trailing or inner alternatives are still rejected inside the quotes.
            for bad in (
                f"${{{{ {good} }}}} || true",
                f"${{{{ {good} || true }}}}",
                f"${{{{ {good} || {a} }}}}",
                f"${{{{ {good} }}}} && ${{{{ true }}}}",
                f"${{{{ !({good}) }}}}",
                f"${{{{ {a} && {b} }}}}",
            ):
                problems = audit(quoted(bad, quote))
                self.assertTrue(any("workflow_run" in p and ("guard" in p or "conjunction" in p) for p in problems), (quote, bad, problems))
        # The unquoted-in-a-quoted-scalar spelling of the real prepare-site guard.
        texts = self.texts()
        prepare = texts["prepare-site.yml"]
        start, end = prepare.index("    if: >-"), prepare.index("    runs-on:")
        real = ("github.event.workflow_run.conclusion == 'success' && " + good)
        for value in (f'"${{{{ {real} }}}}"', "'" + f"${{{{ {real} }}}}".replace("'", "''") + "'"):
            mutated = prepare[:start] + f"    if: {value}\n" + prepare[end:]
            self.assertEqual(audit_all({**texts, "prepare-site.yml": mutated})["prepare-site.yml"], [], value)
            self.assertTrue(audit_all({**texts, "prepare-site.yml": mutated.replace(" }}", " || true }}", 1)})["prepare-site.yml"], value)
        # Quotes that cover only part of the value, or never close, are not unwrapped.
        for value in (
            f'"${{{{ {good} }}}}" && true',
            f'"${{{{ {good} }}}}',
            f"'${{{{ {good.replace(chr(39), chr(39) * 2)} }}}}",
            f"'${{{{ {good} }}}}'",
        ):
            problems = audit(RUN_GOOD[:RUN_GOOD.index("    if: >-")] + f"    if: {value}\n" + RUN_GOOD[RUN_GOOD.index("    runs-on:"):])
            self.assertTrue(problems, value)
        for text in ('"${{ a }}" && true', '"${{ a }}', "'${{ a }}", '"${{ a }} "x""'):
            terms, error = condition_terms(text)
            self.assertIn("quoted scalar", error or "", text)
        self.assertNotIn("wrappers", condition_terms('"${{ a }}')[1])
        # Quote characters inside a block scalar are literal text, not YAML quoting.
        terms, error = condition_terms('>- "${{ a && b }}"')
        self.assertIn("block scalar", error)
        self.assertEqual(condition_terms("\"${{ a && 'x' == b }}\""), (["a", "'x' == b"], None))
        self.assertEqual(condition_terms("'${{ a && ''x'' == b }}'"), (["a", "'x' == b"], None))
        # The secret sweep still reads a quoted condition.
        for value in ('"${{ secrets.X }}"', "'${{ secrets.X }}'", '"${{ SECRETS.X != \'\' }}"'):
            self.rejected(lambda t, v=value: t + f"      - if: {v}\n        run: x\n", "secret other than GITHUB_TOKEN")
        self.assertEqual(audit(GOOD + '      - if: "${{ github.event_name == \'push\' }}"\n        run: x\n'), [])

    def test_double_quoted_escapes_other_than_quote_and_backslash_fail_closed(self):
        a = "github.event.workflow_run.event == 'push'"
        b = "github.event.workflow_run.head_branch == 'main'"
        c = "github.event.workflow_run.head_repository.full_name == github.repository"
        good = f"{a} && {b} && {c}"

        def condition(body):
            start = RUN_GOOD.index("    if: >-")
            return RUN_GOOD[:start] + f'    if: "{body}"\n' + RUN_GOOD[RUN_GOOD.index("    runs-on:"):]

        # YAML decodes these escapes into operators, so reading them as literal text
        # would turn `... && false || true` (always true) into a passing conjunction.
        for escape in ("\\x7C\\x7C", "\\u007c\\u007C", "\\x7c|", "|\\x7c", "\\x28", "\\x29", "\\x21", "\\x26\\x26", "\\n", "\\/"):
            body = "${{ " + good + " && false " + escape + " true }}"
            problems = audit(condition(body))
            self.assertTrue(any("workflow_run" in p or "escape" in p for p in problems), (escape, problems))
            self.assertEqual(condition_terms('"' + body + '"')[0], [], escape)
            self.assertIn("unsupported escape", condition_terms('"' + body + '"')[1], escape)
        for body in (
            "${{ " + good + " }}\\",              # trailing lone backslash
            "${{ " + good + " \\\\\\ }}",    # odd run of backslashes ends in a lone one
            "${{ " + good + " && false \\x7C\\x7C true }}",
        ):
            self.assertTrue(audit(condition(body)), body)
        self.assertIn("unsupported escape", condition_terms('"${{ a }}\\"')[1])
        # A double backslash is a backslash plus literal text, not an escape sequence.
        self.assertEqual(condition_terms('"${{ a && \'\\\\x7C\\\\x7C\' == b }}"'), (["a", "'\\x7c\\x7c' == b"], None))
        # Plain, escaped-quote and single-quoted spellings still work.
        self.assertEqual(audit(condition("${{ " + good + " }}")), [])
        self.assertEqual(condition_terms('"${{ a && contains(x, \\"y\\") }}"'), (["a", 'contains(x, "y")'], None))
        self.assertEqual(condition_terms("'${{ a && b == ''push'' }}'"), (["a", "b == 'push'"], None))
        # The same applies wherever a double-quoted value drives a rule or holds an expression.
        sha = "3d3c42e5aac5ba805825da76410c181273ba90b1"
        for mutate in (
            lambda t: t.replace("persist-credentials: false", 'persist-credentials: false\n          ref: "${{ github.\\x68ead_ref }}"'),
            lambda t: t.replace("persist-credentials: false", 'persist-credentials: false\n          ref: "refs/\\x70ull/1/head"'),
            lambda t: t.replace(f"actions/checkout@{sha}", f'"actions/ch\\x65ckout@{sha}"'),
            lambda t: t.replace("runs-on: ubuntu-latest", 'runs-on: "self-\\x68osted"'),
            lambda t: t.replace("persist-credentials: false", 'persist-credentials: "f\\x61lse"'),
            lambda t: t + '      - run: x\n        env:\n          K: "${{ \\x73ecrets.K }}"\n',
            lambda t: t.replace("branches: [main]", 'branches: ["ma\\x69n"]'),
            lambda t: t + '      - if: "${{ always() && \\x73ecrets.K }}"\n        run: x\n',
        ):
            text = mutate(GOOD)
            self.assertNotEqual(text, GOOD)
            self.assertTrue(audit(text), text)
        self.assertIn("unsupported escape", "".join(audit(GOOD.replace("persist-credentials: false", 'persist-credentials: false\n          ref: "refs/\\x70ull/1/head"'))))
        # Ordinary escapes in values that drive nothing are left alone.
        for step in (
            '      - name: "tab\\tseparated and \\"quoted\\""\n        run: x\n',
            '      - run: x\n        env:\n          NOTE: "line\\nbreak \\\\ backslash"\n',
        ):
            self.assertEqual(audit(GOOD + step), [], step)

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
