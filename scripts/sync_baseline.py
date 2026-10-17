#!/usr/bin/env python3
"""Refresh derived counts/fingerprint after an intentional planning edit."""
from __future__ import annotations

import collections
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1] / "planning"


def load(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def write(name, data):
    (ROOT / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def synchronize():
    backlog = load("project-backlog.json")
    packages = [w for e in backlog["epics"] for w in e["work_packages"]]
    counts = {
        "programs": 1,
        "epics": len(backlog["epics"]),
        "work_packages": len(packages),
        "checklist_tasks": sum(len(w["tasks"]) for w in packages),
        "proposed_issues": 1 + len(backlog["epics"]) + len(packages),
        "blocked_by_edges": sum(len(w["blocked_by"]) for w in packages),
    }
    backlog["counts"] = counts
    write("project-backlog.json", backlog)
    metrics = load("metrics-and-ingestion.json")
    catalog = metrics["metrics"]
    coverage = load("metric-backlog-coverage.json")
    coverage["summary"].update({
        "catalog_metrics": len(catalog),
        "mapped_metrics": len(coverage["mappings"]),
        "unmapped_metrics": len({m["id"] for m in catalog} - {m["metric_id"] for m in coverage["mappings"]}),
        "backlog_work_packages": len(packages),
        "release_eligibility_counts": dict(collections.Counter(m["release_eligibility"] for m in coverage["mappings"])),
    })
    write("metric-backlog-coverage.json", coverage)
    concept = load("concept.json")
    concept["backlog"] = counts
    concept["metric_catalog"]["total"] = len(catalog)
    concept["metric_catalog"]["families"] = dict(collections.Counter(m["family"] for m in catalog))
    write("concept.json", concept)
    ui_map = load("ui/ui-backlog-coverage.json")
    ui_map["master_counts"] = counts
    normalized = (ROOT / "project-backlog.json").read_text(encoding="utf-8").encode("utf-8")
    ui_map["master_sha256"] = hashlib.sha256(normalized).hexdigest()
    write("ui/ui-backlog-coverage.json", ui_map)
    print("Derived baseline counts and UI fingerprint synchronized. Run validation before committing.")


if __name__ == "__main__":
    synchronize()
