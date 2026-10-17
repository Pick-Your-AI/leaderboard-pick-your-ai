#!/usr/bin/env python3
"""Validate planning integrity without contacting GitHub or inferring source truth."""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import pathlib
import re
import sys
from urllib.parse import unquote, urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = {
    "backlog": "project-backlog.json",
    "metrics": "metrics-and-ingestion.json",
    "metric_map": "metric-backlog-coverage.json",
    "ui": "ui/ui-concept.json",
    "ui_map": "ui/ui-backlog-coverage.json",
    "release": "release-manifest.json",
    "decisions": "decision-register.json",
    "concept": "concept.json",
}


def load_bundle(root=ROOT):
    return {key: json.loads((root / "planning" / name).read_text(encoding="utf-8")) for key, name in FILES.items()}


def count_backlog(backlog):
    packages = [w for e in backlog["epics"] for w in e["work_packages"]]
    return {
        "programs": 1,
        "epics": len(backlog["epics"]),
        "work_packages": len(packages),
        "checklist_tasks": sum(len(w["tasks"]) for w in packages),
        "proposed_issues": 1 + len(backlog["epics"]) + len(packages),
        "blocked_by_edges": sum(len(w["blocked_by"]) for w in packages),
    }


def walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_strings(item)


def validate_bundle(bundle):
    errors = []
    b = bundle["backlog"]
    epics = b["epics"]
    packages = [w for e in epics for w in e["work_packages"]]
    records = [b["program"], *epics, *packages]
    tasks = [t for w in packages for t in w["tasks"]]
    ids = [r["id"] for r in records] + [t["id"] for t in tasks]
    duplicates = [key for key, n in collections.Counter(ids).items() if n > 1]
    if duplicates:
        errors.append("Duplicate plan IDs: " + ", ".join(duplicates))
    package_ids = {w["id"] for w in packages}
    task_ids = {t["id"] for t in tasks}
    by_package = {w["id"]: w for w in packages}
    by_task = {t["id"]: w["id"] for w in packages for t in w["tasks"]}
    expected_fields = {"Status", "Priority", "Readiness", "Level", "Phase", "Workstream", "Acceptance Gate"}
    if set(b["project_fields"]) != expected_fields:
        errors.append("Project must have the seven canonical fields")
    for field, options in b["project_fields"].items():
        if not options or len(options) != len(set(options)):
            errors.append(f"Field {field} has missing or duplicate options")
    for record in records:
        for field, options in b["project_fields"].items():
            value = record.get(field.lower().replace(" ", "_"))
            if value not in options:
                errors.append(f"{record['id']}: invalid {field}: {value}")
        wanted_type = "Task" if record["level"] == "Work package" else "Feature"
        if record.get("issue_type") != wanted_type:
            errors.append(f"{record['id']}: unexpected native issue type")
    for e in epics:
        if e.get("parent") != b["program"]["id"]:
            errors.append(f"{e['id']}: wrong program parent")
        for w in e["work_packages"]:
            if w.get("parent") != e["id"]:
                errors.append(f"{w['id']}: wrong epic parent")
            if not w["tasks"] or not w.get("acceptance_criteria") or not w.get("completion_evidence"):
                errors.append(f"{w['id']}: missing tasks or acceptance evidence")
            if len(w["blocked_by"]) != len(set(w["blocked_by"])):
                errors.append(f"{w['id']}: duplicate prerequisite")
            for dep in w["blocked_by"]:
                if dep not in package_ids:
                    errors.append(f"{w['id']}: unknown prerequisite {dep}")
            for task in w["tasks"]:
                if not task["id"].startswith(w["id"] + ".T"):
                    errors.append(f"{task['id']}: task belongs to wrong package")
                if not isinstance(task.get("done"), bool):
                    errors.append(f"{task['id']}: completion flag must be boolean")
            for ref in w.get("references", []):
                url = urlsplit(ref.get("url", ""))
                if url.scheme != "https" or not url.hostname or url.username or url.password:
                    errors.append(f"{w['id']}: source URL must be public HTTPS without credentials")
    visited, visiting = set(), set()

    def visit(key):
        if key in visiting:
            errors.append(f"Dependency cycle at {key}")
            return
        if key in visited or key not in by_package:
            return
        visiting.add(key)
        for dependency in by_package[key]["blocked_by"]:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in package_ids:
        visit(key)
    counts = count_backlog(b)
    for label, actual in [("backlog", b["counts"]), ("concept", bundle["concept"]["backlog"]), ("UI map", bundle["ui_map"]["master_counts"])]:
        if actual != counts:
            errors.append(f"Derived counts differ in {label}")
    catalog = bundle["metrics"]["metrics"]
    metric_ids = [m["id"] for m in catalog]
    if len(metric_ids) != len(set(metric_ids)):
        errors.append("Duplicate metric IDs")
    catalog_by_id = {m["id"]: m for m in catalog}
    maps = bundle["metric_map"]["mappings"]
    map_ids = [m["metric_id"] for m in maps]
    if len(map_ids) != len(set(map_ids)) or set(map_ids) != set(metric_ids):
        errors.append("Metric mapping must cover every metric exactly once")
    allowed_classes = set(bundle["metric_map"]["policy"]["eligibility_classes"])
    for m in catalog:
        definition = m.get("definition", {})
        required = {"unit", "aggregation", "numerator", "denominator", "denominator_filter_rule", "display_policy", "release_eligibility", "source_coverage_class", "event_clock", "subjective_qualification", "launch_gate"}
        if not required <= set(definition) or any(definition[k] in (None, "") for k in required & set(definition)):
            errors.append(f"{m['id']}: incomplete metric definition")
        if definition.get("release_eligibility") not in allowed_classes:
            errors.append(f"{m['id']}: unknown release class")
        if not m.get("source") or not m.get("attribution"):
            errors.append(f"{m['id']}: missing source or attribution")
        if not m.get("backlog_work_packages") or not set(m.get("backlog_work_packages", [])) <= package_ids:
            errors.append(f"{m['id']}: missing or unknown delivery package")
    for mapping in maps:
        metric = catalog_by_id.get(mapping["metric_id"])
        if not metric:
            continue
        if mapping.get("definition") != metric.get("definition"):
            errors.append(f"{metric['id']}: definition differs between catalog and mapping")
        if mapping["primary_work_packages"] != metric["backlog_work_packages"]:
            errors.append(f"{metric['id']}: package mapping differs")
        if mapping["release_eligibility"] != metric["definition"]["release_eligibility"]:
            errors.append(f"{metric['id']}: release class differs")
    for w in packages:
        if not set(w.get("metric_ids", [])) <= set(metric_ids):
            errors.append(f"{w['id']}: unknown metric reference")
    ui_children = [child for epic in bundle["ui"]["ui_backlog"] for child in epic["children"]]
    source_ui_ids = {child["id"] for child in ui_children}
    mappings = bundle["ui_map"]["mappings"]
    mapped_ui_ids = [mapping["ui_child_id"] for mapping in mappings]
    if len(mapped_ui_ids) != len(set(mapped_ui_ids)) or set(mapped_ui_ids) != source_ui_ids:
        errors.append("UI mapping must cover every UI item exactly once")
    for mapping in mappings:
        targets = mapping["primary_work_packages"] + mapping["supporting_work_packages"]
        if not mapping["primary_work_packages"] or not set(targets) <= package_ids:
            errors.append(f"{mapping['ui_child_id']}: unknown UI target package")
        for evidence in mapping["master_evidence"]:
            package = evidence["work_package"]
            if package not in package_ids:
                errors.append(f"{mapping['ui_child_id']}: unknown UI evidence package")
            for task in evidence.get("task_ids", []):
                if task not in task_ids or by_task.get(task) != package:
                    errors.append(f"{mapping['ui_child_id']}: unknown or mismatched UI task {task}")
    consultation = bundle["ui"]["consultation"]
    if consultation.get("observed_canonical_model") != "claude-opus-5-5" or not consultation.get("successful"):
        errors.append("UI attribution must preserve the successful actual model consultation")
    for collection_name in ["release", "decisions"]:
        for value in walk_strings(bundle[collection_name]):
            for key in re.findall(r"\bLB-\d{2}\.\d{2}\b", value):
                if key not in package_ids:
                    errors.append(f"{collection_name}: unknown package {key}")
    summary = bundle["metric_map"]["summary"]
    if summary["catalog_metrics"] != len(catalog) or summary["mapped_metrics"] != len(maps) or summary["backlog_work_packages"] != len(packages):
        errors.append("Metric coverage summary is stale")
    return errors


def validate_files(root=ROOT, allow_unpublished=False):
    errors = []
    mapping = json.loads((root / "planning/ui/ui-backlog-coverage.json").read_text(encoding="utf-8"))
    normalized = (root / "planning/project-backlog.json").read_text(encoding="utf-8").encode("utf-8")
    digest = hashlib.sha256(normalized).hexdigest()
    if mapping["master_sha256"] != digest:
        errors.append("UI mapping fingerprint is stale; review and run scripts/sync_baseline.py")
    for path in [*(root / "planning").rglob("*.json"), *root.rglob("*.md")]:
        if ".git" in path.parts or "node_modules" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"[A-Za-z]:[\\/](?:Users|home)[\\/]|/Users/[^/]+/|/home/[^/]+/", text):
            errors.append(f"{path.relative_to(root)}: private local path")
        if re.search(r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----", text):
            errors.append(f"{path.relative_to(root)}: possible secret material")
        if path.suffix != ".md":
            continue
        if not allow_unpublished and ("{{PROJECT_URL}}" in text or "{{PROGRAM_URL}}" in text):
            errors.append(f"{path.relative_to(root)}: unresolved publication URL")
        for target in re.findall(r"\[[^\]\n]+\]\(([^\s)]+)\)", text):
            if target.startswith(("http:", "https:", "mailto:", "#", "{{")):
                continue
            target_path = unquote(target.split("#", 1)[0])
            if target_path and not (path.parent / target_path).exists():
                errors.append(f"{path.relative_to(root)}: missing local link {target}")
    return errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-unpublished", action="store_true", help="permit URL placeholders during initial publication only")
    args = parser.parse_args()
    try:
        bundle = load_bundle()
        errors = validate_bundle(bundle) + validate_files(allow_unpublished=args.allow_unpublished)
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise SystemExit(f"Invalid planning input: {exc}") from exc
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        raise SystemExit(1)
    counts = count_backlog(bundle["backlog"])
    print(f"Valid plan: {counts['epics']} epics, {counts['work_packages']} packages, {counts['checklist_tasks']} tasks, {counts['blocked_by_edges']} dependencies, {len(bundle['metrics']['metrics'])} metrics, {len(bundle['ui_map']['mappings'])} UI mappings.")
    print("Checks do not prove source truth, runtime implementation, deployment or accessibility.")


if __name__ == "__main__":
    main()
