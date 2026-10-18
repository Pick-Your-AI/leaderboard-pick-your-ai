#!/usr/bin/env python3
"""Run the pinned credential scanner without printing matches or identities."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = "8.30.1"
FINDINGS = 23


class RepositoryIgnoreFile(RuntimeError):
    """The pinned scanner always loads the source-root ignore file if present."""


def run_scan(scanner, mode, repository, configuration):
    """Reject repository ignore files and supply an explicit empty external ignore file."""
    repository_ignore = Path(repository) / ".gitleaksignore"
    if repository_ignore.exists() or repository_ignore.is_symlink():
        raise RepositoryIgnoreFile(
            "Repository .gitleaksignore is not permitted; review exact exceptions in .gitleaks.toml")
    with tempfile.TemporaryDirectory(prefix="leaderboard-secret-scan-") as folder:
        report = Path(folder) / "redacted.json"
        ignore = Path(folder) / "empty.ignore"
        ignore.write_text("", encoding="utf-8")
        command = [
            str(scanner), mode, str(repository), "--config", str(configuration),
            "--gitleaks-ignore-path", str(ignore), "--ignore-gitleaks-allow",
            "--redact=100", "--exit-code=" + str(FINDINGS),
            "--report-format=json", "--report-path", str(report),
            "--no-banner", "--no-color", "--log-level=error", "--timeout=120",
        ]
        if mode == "git":
            command.append("--log-opts=--all --full-history")
        result = subprocess.run(command, capture_output=True, text=True, timeout=150)
        if result.returncode not in (0, FINDINGS):
            raise RuntimeError(f"Credential scanner failed (exit {result.returncode}); no pass recorded")
        if not report.is_file():
            raise RuntimeError("Credential scanner produced no verifiable report")
        findings = json.loads(report.read_text(encoding="utf-8"))
        if not isinstance(findings, list) or not all(isinstance(row, dict) for row in findings):
            raise RuntimeError("Credential scanner report is malformed")
        if bool(findings) != (result.returncode == FINDINGS):
            raise RuntimeError("Credential scanner exit status and report disagree")
        # Even the temporary report must have fully redacted secret values.
        if any(row.get("Secret") != "REDACTED" for row in findings):
            raise RuntimeError("Credential scanner did not fully redact its report")
        return result.returncode, findings, result.stdout + result.stderr


def require_clean(scanner, mode, repository, configuration):
    code, findings, _ = run_scan(scanner, mode, repository, configuration)
    if code:
        # Never print Match, Secret, author/email, commit message or scanner stderr.
        for row in findings:
            print(json.dumps({
                "file": row.get("File"), "line": row.get("StartLine"),
                "rule": row.get("RuleID"),
            }, ensure_ascii=True), file=sys.stderr)
        raise RuntimeError(f"{mode} scan detected {len(findings)} credential-shaped value(s)")
    print(f"Credential {mode} scan passed")


def self_test(scanner, configuration):
    """Prove exact fixture exceptions, inline/ignore resistance and deleted-history detection."""
    with tempfile.TemporaryDirectory(prefix="leaderboard-secret-probe-") as folder:
        repository = Path(folder)

        def git(*arguments):
            subprocess.run([
                "git", "-c", "user.name=Synthetic scanner test",
                "-c", "user.email=synthetic@example.invalid",
                "-c", "commit.gpgsign=false", *arguments,
            ], cwd=repository, check=True, capture_output=True, text=True, timeout=30)

        def commit(message):
            git("add", ".")
            git("commit", "-q", "-m", message)

        pipeline = repository / "apps/pipeline/test/harness.mjs"
        ingestion = repository / "packages/ingestion/test/store.test.mjs"
        pipeline.parent.mkdir(parents=True)
        ingestion.parent.mkdir(parents=True)
        # Construct the known dummy values; do not need new exemptions for this runner.
        cursor_fixture = "synthetic" + "-cursor-secret-is-at-least-32-characters"
        webhook_fixture = "synthetic" + "-integration-secret-of-32-characters"
        policies = ["synthetic" + "-policy-v1", "synthetic" + "-policy-v2"]
        pipeline_clean = f'const cursorSecret = {json.dumps(cursor_fixture)};\n'
        ingestion_clean = (f'const secret = {json.dumps(webhook_fixture)};\n'
                           + "".join(f'enqueue(key, {json.dumps(value)});\n' for value in policies))
        pipeline.write_text(pipeline_clean, encoding="utf-8")
        ingestion.write_text(ingestion_clean, encoding="utf-8")
        git("init", "-q")
        commit("Synthetic allowed fixtures")
        require_clean(scanner, "git", repository, configuration)
        require_clean(scanner, "dir", repository, configuration)

        # Generated, never-issued test strings; never commit either to this repository.
        provider = "ghp_" + hashlib.sha256(b"leaderboard synthetic provider probe").hexdigest()[:36]
        generic = hashlib.sha256(b"leaderboard synthetic generic probe").hexdigest()
        pipeline.write_text(pipeline_clean + f'const githubToken = "{provider}"; // gitleaks:allow\n', encoding="utf-8")
        ingestion.write_text(ingestion_clean + f'const secret = "{generic}"; // gitleaks:allow\n', encoding="utf-8")

        def require_detection(mode):
            code, rows, output = run_scan(scanner, mode, repository, configuration)
            rules = {row.get("RuleID") for row in rows}
            if code != FINDINGS or not {"github-pat", "generic-api-key"} <= rules:
                raise RuntimeError(f"Synthetic {mode} credential rejection probe failed (exit {code}, rules {sorted(rules)})")
            if any(value in json.dumps(rows) + output for value in (provider, generic)):
                raise RuntimeError("Synthetic credential redaction probe failed")
            return rows

        require_detection("dir")
        commit("Synthetic credential rejection specimen")
        pipeline.write_text(pipeline_clean, encoding="utf-8")
        ingestion.write_text(ingestion_clean, encoding="utf-8")
        commit("Remove synthetic specimen from working tree")
        require_clean(scanner, "dir", repository, configuration)
        history = require_detection("git")
        (repository / ".gitleaksignore").write_text(
            "\n".join(row["Fingerprint"] for row in history) + "\n", encoding="utf-8")
        try:
            require_clean(scanner, "git", repository, configuration)
        except RepositoryIgnoreFile:
            pass
        else:
            raise RuntimeError("Repository ignore-file rejection probe failed")
        print("Credential rejection, exact-exception, redaction and deleted-history probes passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gitleaks", required=True, type=Path, help="Verified Gitleaks 8.30.1 executable")
    parser.add_argument("--self-test", action="store_true", help="Run disposable synthetic gate probes")
    arguments = parser.parse_args()
    scanner = arguments.gitleaks.resolve(strict=True)
    version = subprocess.run([str(scanner), "version"], capture_output=True, text=True, check=True, timeout=10)
    if version.stdout.strip() != VERSION:
        raise RuntimeError("Credential scanner version does not match the reviewed pin")
    configuration = ROOT / ".gitleaks.toml"
    if arguments.self_test:
        self_test(scanner, configuration)
    else:
        require_clean(scanner, "git", ROOT, configuration)
        require_clean(scanner, "dir", ROOT, configuration)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Scanner diagnostics can include input data. Only our fixed status messages leave this boundary.
        message = str(error) if isinstance(error, RuntimeError) else "Credential scan could not complete"
        print(message, file=sys.stderr)
        sys.exit(1)
