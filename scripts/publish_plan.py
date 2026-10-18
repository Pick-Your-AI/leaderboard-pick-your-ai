#!/usr/bin/env python3
"""Offline-first, append-only publication reconciliation. No network or credentials.

An authorized host may inject an adapter; the CLI only plans from captured reads.
The adapter must serialize publishers, exhaust all-state issue pagination, read
native parents, and never replace an existing parent. See docs/PUBLICATION.md.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Protocol

ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = "pick-your-ai-leaderboard-plan:"
ID = r"LB(?:-[0-9]{2}(?:\.[0-9]{2})?)?"
MARKER = re.compile(r"<!-- " + NAMESPACE + "(" + ID + r") -->")
MAX_PAGES = 100
MAX_ISSUES = 10000


class PublicationError(ValueError):
    """Fail closed before another mutation; retain the journal for reconciliation."""


class UncertainAction(PublicationError):
    """A durable intent has no confirmed remote outcome. Never retry it blindly."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def positive(value):
    return type(value) is int and value > 0


def repository(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise PublicationError("Expected a canonical GitHub repository URL")
    return value


def specs_from_backlog(backlog):
    """Flatten parents first. Readiness and missing decisions do not block creation."""
    specs = [backlog["program"]]
    for epic in backlog["epics"]:
        specs.extend([epic, *epic["work_packages"]])
    validate_specs(specs)
    return specs


def validate_specs(specs):
    if not specs or len(specs) > MAX_ISSUES:
        raise PublicationError("Missing or over-bound publication specs")
    seen = set()
    for index, spec in enumerate(specs):
        key = spec["id"]
        if not re.fullmatch(ID, key) or key in seen:
            raise PublicationError(f"Invalid or duplicate plan ID: {key}")
        if (index == 0 and (key != "LB" or spec.get("parent") is not None)) or (
                index > 0 and spec.get("parent") not in seen):
            raise PublicationError(f"Invalid or out-of-order plan parent: {key}")
        seen.add(key)


def render_issue(spec):
    """Render only NEW issues. Never merge this text into existing live bodies."""
    lines = [f"<!-- {NAMESPACE}{spec['id']} -->", "## Outcome", "", spec["outcome"]]
    scope = spec.get("scope")
    if scope:
        lines += ["", "## Scope", "", "In: " + scope["in"], "", "Out: " + scope["out"]]
    tasks = spec.get("tasks", [])
    if tasks:
        lines += ["", "## Tasks", ""]
        lines += [f"- [ ] `{task['id']}` {task['title']}" for task in tasks]
    if spec.get("acceptance_criteria"):
        lines += ["", "## Acceptance criteria", ""]
        lines += [f"- [ ] {criterion}" for criterion in spec["acceptance_criteria"]]
    lines += ["", "## Ownership and readiness", "",
              "Initial status: **Backlog**. Unassigned until ownership is accepted.",
              "Readiness: " + spec.get("readiness", "Needs owner") + ".",
              "Parent and prerequisite relationships are native GitHub relationships.",
              "Unresolved decisions do not prevent publication and do not imply readiness."]
    if spec.get("references"):
        lines += ["", "## Evidence and references", ""]
        lines += [f"- [{ref['title']}]({ref['url']})" for ref in spec["references"]]
    lines += ["", "## Completion evidence", "",
              "Link the reviewed deliverable and required verification. Publication is not completion.", ""]
    return {"title": spec.get("publication_title", spec["title"]),
            "body": "\n".join(lines), "labels": list(spec.get("labels", [])),
            "issue_type": spec["issue_type"]}


def read_inventory(inventory, repo):
    """Require an explicit, exhausted cursor chain, including closed issues.

    Pages contain issues (not PRs); source_count counts all source rows. Adapters
    must include native parent reads on every marked/recorded issue. No endpoint
    that silently caps search results is a valid inventory source.
    """
    if inventory.get("repository_url") != repository(repo) or inventory.get("state") != "all":
        raise PublicationError("Inventory must cover the target repository and state=all")
    pages = inventory.get("pages", [])
    if not pages or len(pages) > MAX_PAGES:
        raise PublicationError("Missing or over-bound inventory pages")
    cursor, cursors, numbers, ids, issues = None, set(), set(), set(), []
    for index, page in enumerate(pages):
        if not {"cursor", "next_cursor", "issues", "source_count"} <= page.keys():
            raise PublicationError("Inventory page omits explicit pagination evidence")
        if page.get("cursor") != cursor or cursor in cursors:
            raise PublicationError("Broken or repeated pagination cursor")
        cursors.add(cursor)
        rows = page.get("issues")
        count = page.get("source_count")
        if not isinstance(rows, list) or type(count) is not int or count < len(rows):
            raise PublicationError("Invalid inventory page")
        for issue in rows:
            if len(issues) >= MAX_ISSUES:
                raise PublicationError("Issue inventory exceeds publication safety bound")
            number, issue_id = issue.get("number"), issue.get("id")
            if not positive(number) or not positive(issue_id) or number in numbers or issue_id in ids:
                raise PublicationError("Duplicate or invalid remote issue identity across pages")
            if not isinstance(issue.get("body"), str) or not isinstance(issue.get("title"), str):
                raise PublicationError("Inventory must retain identity-bearing body and title")
            numbers.add(number)
            ids.add(issue_id)
            issues.append(issue)
        cursor = page.get("next_cursor")
        if cursor is not None and (not isinstance(cursor, str) or not cursor):
            raise PublicationError("Invalid next pagination cursor")
        if (cursor is None) != (index == len(pages) - 1):
            raise PublicationError("Inventory pagination is incomplete or continues after exhaustion")
    if len(issues) > MAX_ISSUES:
        raise PublicationError("Issue inventory exceeds publication safety bound")
    return issues


def collect_inventory(repo, fetch_page):
    """Adapter helper. Fetch until explicit exhaustion; reject loops and limits."""
    pages, cursor, seen = [], None, set()
    for _ in range(MAX_PAGES):
        if cursor in seen:
            raise PublicationError("Repeated inventory cursor")
        seen.add(cursor)
        page = fetch_page(cursor)
        if page.get("cursor") != cursor:
            raise PublicationError("Adapter returned a different page")
        pages.append(page)
        cursor = page.get("next_cursor")
        if cursor is None:
            result = {"repository_url": repo, "state": "all", "pages": pages}
            read_inventory(result, repo)
            return result
    raise PublicationError("Inventory page bound reached before exhaustion")


def publication_bindings(publication, specs, repo):
    """Historical URL receipts constrain identity; they are never proof of existence."""
    known = {s["id"] for s in specs}
    result, numbers = {}, set()
    for key, url in publication.get("issue_urls", {}).items():
        match = re.fullmatch(re.escape(repository(repo)) + r"/issues/([1-9][0-9]*)", url)
        if key not in known or not match or int(match[1]) in numbers:
            raise PublicationError("Invalid, duplicate or foreign historical issue binding")
        result[key] = {"number": int(match[1])}
        numbers.add(int(match[1]))
    return result


def reconcile(specs, inventory, repo, bindings=None):
    """Pure planner. Existing issue content, state and Project fields are untouched."""
    validate_specs(specs)
    issues = read_inventory(inventory, repo)
    expected = {s["id"]: s for s in specs}
    titles = {s.get("publication_title", s["title"]): s["id"] for s in specs}
    found = {}
    for issue in issues:
        markers = MARKER.findall(issue["body"])
        if issue["body"].count(NAMESPACE) != len(markers) or len(markers) > 1:
            raise PublicationError(f"Malformed or ambiguous LB marker on #{issue['number']}")
        if not markers:
            if issue["title"] in titles:
                raise PublicationError(f"Unmarked planned title on #{issue['number']}")
            continue
        key = markers[0]
        if key not in expected or key in found:
            raise PublicationError(f"Unknown or duplicate stable marker: {key}")
        if issue.get("parent_readback") is not True or "parent_number" not in issue:
            raise PublicationError(f"Missing native-parent readback: {key}")
        if issue["parent_number"] is not None and not positive(issue["parent_number"]):
            raise PublicationError(f"Invalid native parent: {key}")
        found[key] = issue
    for key, binding in (bindings or {}).items():
        issue = found.get(key)
        if key not in expected or issue is None or binding.get("number") != issue["number"] or (
                "id" in binding and binding["id"] != issue["id"]):
            raise PublicationError(f"Receipt identity missing or changed: {key}; do not recreate")
    actions = []
    for spec in specs:
        key, parent = spec["id"], spec.get("parent")
        issue = found.get(key)
        if issue is None:
            actions.append({"kind": "create_issue", "plan_id": key})
        if parent is None:
            if issue and issue["parent_number"] is not None:
                raise PublicationError("The root program has an unexpected native parent")
            continue
        parent_issue = found.get(parent)
        if issue and issue["parent_number"] is not None:
            if parent_issue is None or issue["parent_number"] != parent_issue["number"]:
                raise PublicationError(f"Conflicting native parent for {key}; never reparent")
        else:
            actions.append({"kind": "attach_parent", "plan_id": key, "parent_id": parent})
    return {"actions": actions,
            "bindings": {k: {"number": v["number"], "id": v["id"]} for k, v in found.items()},
            "existing_issues": len(found),
            "verified_parent_edges": sum(v["parent_number"] is not None for v in found.values()),
            "noop": not actions}


class Adapter(Protocol):
    """Connected-integration host contract; implementations are not bundled here.

    inventory(): fresh exhaustive all-state reads plus native parents.
    create_issue(): exactly this payload, no automatic retries on uncertain errors.
    attach_parent(): atomically refuses any existing different parent; no reparent.
    All publishers must share one journal/lock. Independent racing writers cannot
    be made exactly-once by GitHub issue creation (it has no idempotency key).
    """
    def inventory(self) -> dict: ...
    def create_issue(self, payload: dict) -> None: ...
    def attach_parent(self, child_number: int, parent_number: int, *, replace: bool) -> None: ...


class Journal:
    """Atomic, fsynced local receipts plus an OS lock released after a crash."""
    def __init__(self, path, repo, specs):
        self.path, self.repo = Path(path), repository(repo)
        self.plan_hash = digest(specs)
        self.parents = {s["id"]: s.get("parent") for s in specs}

    def load(self):
        if not self.path.exists():
            return {"schema_version": 1, "repository_url": self.repo,
                    "plan_sha256": self.plan_hash, "bindings": {}, "pending": None}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if (data["schema_version"] != 1 or data["repository_url"] != self.repo or
                    data["plan_sha256"] != self.plan_hash or not isinstance(data["bindings"], dict) or
                    not (data["pending"] is None or isinstance(data["pending"], dict))):
                raise PublicationError("Receipt scope or plan changed; review before resuming")
            for binding in data["bindings"].values():
                if not positive(binding["number"]) or not positive(binding["id"]):
                    raise PublicationError("Invalid durable issue binding")
            pending = data["pending"]
            if pending is not None:
                kind, key = pending.get("kind"), pending.get("plan_id")
                if key not in self.parents or kind not in {"create_issue", "attach_parent"}:
                    raise PublicationError("Invalid durable operation intent")
                expected_keys = {"kind", "plan_id"} | ({"parent_id"} if kind == "attach_parent" else set())
                if set(pending) != expected_keys:
                    raise PublicationError("Durable operation intent has a noncanonical shape")
                if kind == "attach_parent" and (self.parents[key] is None or
                                                pending.get("parent_id") != self.parents[key]):
                    raise PublicationError("Durable intent has the wrong parent")
            return data
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise PublicationError(f"Unreadable or invalid publication journal: {error}") from error

    @contextlib.contextmanager
    def lock(self):
        # POSIX-only applying is deliberate. Offline planning is platform independent.
        import fcntl
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.with_suffix(self.path.suffix + ".lock").open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise PublicationError("Another publisher holds this journal lock") from error
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def save(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=self.path.name + ".", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)


def pending_resolved(pending, report, inventory, repo):
    if pending is None:
        return
    kind, key = pending.get("kind"), pending.get("plan_id")
    if kind not in {"create_issue", "attach_parent"} or key not in report["bindings"]:
        raise UncertainAction("Pending operation is absent from readback; stop for investigation")
    expected_keys = {"kind", "plan_id"} | ({"parent_id"} if kind == "attach_parent" else set())
    if set(pending) != expected_keys:
        raise PublicationError("Pending operation has a noncanonical shape")
    if kind == "attach_parent":
        parent = report["bindings"].get(pending["parent_id"])
        if parent is None:
            raise PublicationError("Invalid pending parent identity")
        child_binding = report["bindings"][key]
        child = next((issue for issue in read_inventory(inventory, repo)
                      if issue["number"] == child_binding["number"] and
                      issue["id"] == child_binding["id"]), None)
        # Clearing an intent requires positive edge readback, not merely the
        # absence of an identical action dictionary in the planner's output.
        if (child is None or child.get("parent_readback") is not True or
                child.get("parent_number") != parent["number"]):
            raise UncertainAction("Pending parent edge is not confirmed; stop rather than retry")


def merge_bindings(supplied, durable):
    """Intersect identity constraints; never overwrite contradictory evidence."""
    constraints = dict(supplied or {})
    for binding in constraints.values():
        if (not isinstance(binding, dict) or not {"number"} <= binding.keys() <= {"number", "id"}
                or not positive(binding["number"]) or ("id" in binding and not positive(binding["id"]))):
            raise PublicationError("Invalid supplied identity constraint")
    for key, binding in durable.items():
        if key in constraints and any(constraints[key][field] != binding[field]
                                      for field in constraints[key]):
            raise PublicationError("Historical and durable receipts disagree")
        constraints[key] = binding
    return constraints


def publish(specs, repo, adapter, journal, *, dry_run=True, max_mutations=20, bindings=None):
    """Bounded apply with write-ahead intents and fresh readback after every action.

    Uncertain calls remain pending even if they raised before reaching the server.
    A resume adopts a uniquely marked observed result; absence requires explicit
    investigation, never a blind retry. A mutation-budget stop is resumable.
    """
    if type(max_mutations) is not int or not 0 <= max_mutations <= 1000:
        raise PublicationError("Mutation budget must be an integer from 0 through 1000")
    if journal.repo != repo or journal.plan_hash != digest(specs):
        raise PublicationError("Journal does not belong to this repository and plan")
    validate_specs(specs)
    payloads = {s["id"]: render_issue(s) for s in specs}
    for key, payload in payloads.items():
        if payload["body"].count(NAMESPACE) != 1 or MARKER.findall(payload["body"]) != [key]:
            raise PublicationError(f"Rendered issue has ambiguous identity: {key}")
    with contextlib.nullcontext() if dry_run else journal.lock():
        state = journal.load()
        mutations = 0
        while True:
            constraints = merge_bindings(bindings, state["bindings"])
            inventory = adapter.inventory()
            report = reconcile(specs, inventory, repo, constraints)
            pending_resolved(state["pending"], report, inventory, repo)
            report["mutations"] = mutations
            if dry_run:
                return report
            state["bindings"], state["pending"] = report["bindings"], None
            journal.save(state)
            if report["noop"] or mutations >= max_mutations:
                return report
            action = report["actions"][0]
            # Intent is durable BEFORE a remote side effect or an uncertain response.
            state["pending"] = action
            journal.save(state)
            if action["kind"] == "create_issue":
                adapter.create_issue(payloads[action["plan_id"]])
            else:
                adapter.attach_parent(report["bindings"][action["plan_id"]]["number"],
                                      report["bindings"][action["parent_id"]]["number"], replace=False)
            mutations += 1


def verification_receipt(specs, inventory, repo, report, *, observed_at):
    """Small, sanitized read-only evidence; no bodies, users or raw API downloads."""
    checked = reconcile(specs, inventory, repo, report["bindings"])
    if not checked["noop"] or checked["bindings"] != report["bindings"]:
        raise PublicationError("Cannot certify an incomplete publication")
    by_number = {i["number"]: i for i in read_inventory(inventory, repo)}
    return {"schema_version": "publication-readback-1", "repository_url": repo,
            "observed_at": observed_at, "mode": "read-only; no GitHub mutations",
            "plan_sha256": digest(specs), "inventory_sha256": digest(inventory),
            "pagination": [{"cursor": p["cursor"], "next_cursor": p["next_cursor"],
                            "source_count": p["source_count"], "issues": len(p["issues"])}
                           for p in inventory["pages"]],
            "result": {k: checked[k] for k in ("existing_issues", "verified_parent_edges", "noop", "actions")},
            "record_columns": ["plan_id", "issue_number", "github_issue_id", "native_parent_number", "body_sha256", "observed_state"],
            "records": [[key, b["number"], b["id"], by_number[b["number"]]["parent_number"],
                         hashlib.sha256(by_number[b["number"]]["body"].encode()).hexdigest(),
                         by_number[b["number"]].get("state", "unknown")]
                        for key, b in sorted(checked["bindings"].items())],
            "limitations": ["Point-in-time sequential API reads, not an atomic GitHub snapshot.",
                            "No Project-field, blocker, issue-type or production-runtime verification.",
                            "Existing issue text and progress are preserved by issuing no updates."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--backlog", type=Path, default=ROOT / "planning/project-backlog.json")
    parser.add_argument("--publication", type=Path, default=ROOT / "docs/PUBLICATION.json")
    args = parser.parse_args()
    try:
        backlog = json.loads(args.backlog.read_text())
        publication = json.loads(args.publication.read_text())
        specs = specs_from_backlog(backlog)
        repo = repository(publication["repository_url"])
        report = reconcile(specs, json.loads(args.inventory.read_text()), repo,
                           publication_bindings(publication, specs, repo))
        print(json.dumps({"mode": "read-only dry run", **report}, indent=2, sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"Publication stopped: {error}\n")


if __name__ == "__main__":
    main()
