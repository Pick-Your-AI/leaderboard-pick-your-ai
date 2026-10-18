#!/usr/bin/env python3
"""Run the pinned credential scanner without printing matches or identities."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = "8.30.1"
FINDINGS = 23
HISTORY_OPTIONS = (
    "--all", "--full-history", "--diff-merges=first-parent",
    "--text", "--no-ext-diff", "--no-textconv",
)
MAX_TRACE_BYTES = 16 * 1024 * 1024
MAX_TRACE_LINE_BYTES = 128 * 1024


class RepositoryIgnoreFile(RuntimeError):
    """The pinned scanner always loads the source-root ignore file if present."""


class HistoryCompletionError(RuntimeError):
    """The actual Git history command has no unambiguous successful completion."""


def require_history_completion(trace, repository):
    """Bind bounded, private Git Trace2 events to the scanner's exact history argv."""
    message = "Git history completion was not verified; no pass recorded"
    sessions = {}
    total = 0

    def malformed(_):
        raise HistoryCompletionError(message)

    def unique_fields(pairs):
        row = {}
        for key, value in pairs:
            if key in row:
                raise HistoryCompletionError(message)
            row[key] = value
        return row

    try:
        with trace.open("rb") as stream:
            while line := stream.readline(MAX_TRACE_LINE_BYTES + 1):
                total += len(line)
                if (total > MAX_TRACE_BYTES or len(line) > MAX_TRACE_LINE_BYTES
                        or not line.endswith(b"\n")):
                    raise HistoryCompletionError(message)
                row = json.loads(line, object_pairs_hook=unique_fields, parse_constant=malformed)
                if (not isinstance(row, dict) or not isinstance(row.get("event"), str)
                        or not isinstance(row.get("sid"), str) or not row["sid"]):
                    raise HistoryCompletionError(message)
                session = sessions.setdefault(row["sid"], {"control": [], "last": None})
                if len(sessions) > 64:
                    raise HistoryCompletionError(message)
                session["last"] = row["event"]
                if row["event"] in ("version", "start", "exit", "atexit", "signal"):
                    session["control"].append(row)
                    if len(session["control"]) > 8:
                        raise HistoryCompletionError(message)
    except (OSError, ValueError, RecursionError):
        raise HistoryCompletionError(message) from None

    expected = ["-C", os.path.normpath(str(repository)), "log", "-p", "-U0", *HISTORY_OPTIONS]
    matches = [session for session in sessions.values() if any(
        row["event"] == "start" and isinstance(row.get("argv"), list)
        and row["argv"][1:] == expected for row in session["control"])]
    if len(matches) != 1:
        raise HistoryCompletionError(message)
    session = matches[0]
    control = session["control"]
    if ([row["event"] for row in control] != ["version", "start", "exit", "atexit"]
            or control[0].get("evt") != "4" or session["last"] != "atexit"
            or any(row.get("thread") != "main" for row in control)
            or any(type(row.get("code")) is not int or row["code"] != 0 for row in control[2:])):
        raise HistoryCompletionError(message)


def run_scan(scanner, mode, repository, configuration):
    """Reject repository ignore files and supply an explicit empty external ignore file."""
    repository_ignore = Path(repository) / ".gitleaksignore"
    if repository_ignore.exists() or repository_ignore.is_symlink():
        raise RepositoryIgnoreFile(
            "Repository .gitleaksignore is not permitted; review exact exceptions in .gitleaks.toml")
    with tempfile.TemporaryDirectory(prefix="leaderboard-secret-scan-") as folder:
        report = Path(folder) / "redacted.json"
        ignore = Path(folder) / "empty.ignore"
        trace = Path(folder) / "history-events.json"
        ignore.write_text("", encoding="utf-8")
        command = [
            str(scanner), mode, str(repository), "--config", str(configuration),
            "--gitleaks-ignore-path", str(ignore), "--ignore-gitleaks-allow",
            "--redact=100", "--exit-code=" + str(FINDINGS),
            "--report-format=json", "--report-path", str(report),
            "--no-banner", "--no-color", "--log-level=error", "--timeout=120",
        ]
        environment = None
        if mode == "git":
            command.append("--log-opts=" + " ".join(HISTORY_OPTIONS))
            environment = {**os.environ, "GIT_TRACE2_EVENT": str(trace),
                           "GIT_TRACE2_EVENT_BRIEF": "1", "GIT_TRACE2_EVENT_NESTING": "1"}
        result = subprocess.run(command, capture_output=True, text=True, timeout=150, env=environment)
        # The pinned CLI can log a source failure and still return exit 0 with
        # an empty report. Error-only/no-banner scans must produce no diagnostics.
        # Keep their contents private; they can contain paths or source material.
        if result.stdout or result.stderr:
            raise RuntimeError("Credential scanner reported an incomplete or unreadable source; no pass recorded")
        if result.returncode not in (0, FINDINGS):
            raise RuntimeError(f"Credential scanner failed (exit {result.returncode}); no pass recorded")
        if mode == "git":
            require_history_completion(trace, repository)
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


def rejection_probe(scanner, configuration, merge_only=False):
    """Detect each deleted specimen in an ordinary commit or only in a merge result."""
    with tempfile.TemporaryDirectory(prefix="leaderboard-secret-probe-") as folder:
        repository = Path(folder)

        def git(*arguments):
            return subprocess.run([
                "git", "-c", "user.name=Synthetic scanner test",
                "-c", "user.email=synthetic@example.invalid",
                "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *arguments,
            ], cwd=repository, check=True, capture_output=True, text=True, timeout=30).stdout.strip()

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

        if merge_only:
            initial = git("rev-parse", "HEAD")
            git("checkout", "-q", "-b", "probe-side")
            (repository / "side.txt").write_text("Synthetic side branch\n", encoding="utf-8")
            commit("Synthetic side branch")
            git("checkout", "-q", "-b", "probe-main", initial)
            (repository / "main.txt").write_text("Synthetic main branch\n", encoding="utf-8")
            commit("Synthetic main branch")
            # Both parents contain only the accepted fixtures; the specimens will
            # first appear in the two-parent merge, then disappear in a later commit.
            for parent in ("HEAD", "probe-side"):
                for path, clean in ((pipeline, pipeline_clean), (ingestion, ingestion_clean)):
                    if git("show", f"{parent}:{path.relative_to(repository).as_posix()}") != clean.strip():
                        raise RuntimeError("Synthetic merge parent preparation failed")
            git("merge", "--no-commit", "--no-ff", "probe-side")

        # Generated, never-issued test strings; never commit either to this repository.
        provider = "ghp_" + hashlib.sha256(b"leaderboard synthetic provider probe").hexdigest()[:36]
        generic = hashlib.sha256(b"leaderboard synthetic generic probe").hexdigest()
        pipeline.write_text(pipeline_clean + f'const githubToken = "{provider}"; // gitleaks:allow\n', encoding="utf-8")
        ingestion.write_text(ingestion_clean + f'const secret = "{generic}"; // gitleaks:allow\n', encoding="utf-8")
        specimen_commit = None

        def require_detection(mode):
            code, rows, output = run_scan(scanner, mode, repository, configuration)
            expected = (
                ("github-pat", pipeline, len(pipeline_clean.splitlines()) + 1),
                ("generic-api-key", ingestion, len(ingestion_clean.splitlines()) + 1),
            )
            missing = [
                f"{rule}:{path.relative_to(repository).as_posix()}:{line}"
                for rule, path, line in expected
                if not any(
                    row.get("RuleID") == rule and row.get("StartLine") == line
                    and row.get("File") in (str(path), path.relative_to(repository).as_posix())
                    and (mode != "git" or row.get("Commit") == specimen_commit)
                    for row in rows)
            ]
            if code != FINDINGS or missing:
                raise RuntimeError(f"Synthetic {mode} credential rejection probe failed (exit {code}, missing {missing})")
            if any(value in json.dumps(rows) + output for value in (provider, generic)):
                raise RuntimeError("Synthetic credential redaction probe failed")
            return rows

        require_detection("dir")
        commit("Synthetic credential rejection specimen")
        specimen_commit = git("rev-parse", "HEAD")
        if merge_only and len(git("show", "-s", "--format=%P", "HEAD").split()) != 2:
            raise RuntimeError("Synthetic merge specimen does not have two parents")
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


def history_visibility_probe(scanner, configuration, kind):
    """Require the original deleted specimen despite Git file presentation settings."""
    with tempfile.TemporaryDirectory(prefix="leaderboard-secret-history-") as folder:
        root = Path(folder)
        repository = root / "repository"
        repository.mkdir()

        def git(*arguments):
            return subprocess.run([
                "git", "-c", "user.name=Synthetic scanner test",
                "-c", "user.email=synthetic@example.invalid",
                "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *arguments,
            ], cwd=repository, check=True, capture_output=True, text=True, timeout=30).stdout.strip()

        git("init", "-q")
        specimen = repository / "specimen.txt"
        marker = root / "helper-called"
        # The generated value exists only inside this disposable repository.
        provider = "ghp_" + hashlib.sha256(b"leaderboard synthetic historical visibility").hexdigest()[:36]
        payload = f'const githubToken = "{provider}";\n'.encode("utf-8")
        if kind == "nul":
            payload += b"\x00Synthetic binary classification\n"
        elif kind == "attribute":
            (repository / ".gitattributes").write_text("specimen.txt -diff\n", encoding="utf-8")
        elif kind == "textconv":
            helper = root / "synthetic_converter.py"
            helper.write_text(
                f"from pathlib import Path\nPath({str(marker)!r}).write_text('called')\n"
                "print('Synthetic transformed content')\n", encoding="utf-8")
            (repository / ".gitattributes").write_text("specimen.txt diff=synthetic\n", encoding="utf-8")
            command = shlex.join([sys.executable, str(helper)])
            git("config", "diff.synthetic.textconv", command)
            git("config", "diff.external", command)
        else:
            raise ValueError("Unknown synthetic history probe")
        specimen.write_bytes(payload)
        git("add", ".")
        git("commit", "-q", "-m", "Synthetic historical visibility specimen")
        specimen_commit = git("rev-parse", "HEAD")
        specimen.unlink()
        git("add", ".")
        git("commit", "-q", "-m", "Delete synthetic visibility specimen")
        require_clean(scanner, "dir", repository, configuration)
        code, rows, output = run_scan(scanner, "git", repository, configuration)
        if marker.exists():
            raise RuntimeError("Synthetic source helper ran during the credential scan")
        if code != FINDINGS or not any(
                row.get("RuleID") == "github-pat" and row.get("StartLine") == 1
                and row.get("File") in ("specimen.txt", str(specimen))
                and row.get("Commit") == specimen_commit for row in rows):
            raise RuntimeError(f"Synthetic {kind} history visibility probe failed")
        if provider in json.dumps(rows) + output:
            raise RuntimeError("Synthetic history visibility redaction probe failed")


def silent_history_exit_probe(scanner, configuration, repository):
    """Require intact controls around a silent failure of the actual Git history child."""
    require_clean(scanner, "git", repository, configuration)
    require_clean(scanner, "dir", repository, configuration)
    # This private wrapper injects a silent failure only into the history
    # child. The pinned scanner itself otherwise incorrectly returns zero.
    real_git = shutil.which("git")
    if real_git is None:
        raise RuntimeError("Synthetic Git completion probe could not find Git")
    with tempfile.TemporaryDirectory(prefix="leaderboard-secret-child-probe-") as child_folder:
        wrapper = Path(child_folder) / "git"
        wrapper.write_text(
            '#!/bin/sh\nif [ "$3" = "log" ]; then\n  exit 73\nfi\nexec '
            + shlex.quote(real_git) + ' "$@"\n', encoding="utf-8")
        wrapper.chmod(0o700)
        fault = subprocess.run([str(wrapper), "-C", str(repository), "log"],
                               capture_output=True, text=True, timeout=10)
        if fault.returncode != 73 or fault.stdout or fault.stderr:
            raise RuntimeError("Synthetic silent Git failure was not established")
        previous_path = os.environ.get("PATH")
        os.environ["PATH"] = child_folder + os.pathsep + (previous_path or os.defpath)
        try:
            try:
                run_scan(scanner, "git", repository, configuration)
            except HistoryCompletionError:
                pass
            else:
                raise RuntimeError("Synthetic silent Git completion rejection probe failed")
        finally:
            if previous_path is None:
                os.environ.pop("PATH", None)
            else:
                os.environ["PATH"] = previous_path
    require_clean(scanner, "git", repository, configuration)
    require_clean(scanner, "dir", repository, configuration)


def source_failure_probe(scanner, configuration, missing_blob=False):
    """A nonrepository or unreadable retained Git object cannot report a clean scan."""
    with tempfile.TemporaryDirectory(prefix="leaderboard-secret-source-") as folder:
        repository = Path(folder)
        specimen = repository / "synthetic.txt"
        specimen.write_text("Synthetic source content\n", encoding="utf-8")
        if missing_blob:
            def git(*arguments):
                return subprocess.run([
                    "git", "-c", "user.name=Synthetic scanner test",
                    "-c", "user.email=synthetic@example.invalid",
                    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *arguments,
                ], cwd=repository, check=True, capture_output=True, text=True, timeout=30).stdout.strip()

            git("init", "-q")
            git("add", ".")
            git("commit", "-q", "-m", "Synthetic retained source")
            blob = git("rev-parse", "HEAD:synthetic.txt")
            specimen.unlink()
            git("add", ".")
            git("commit", "-q", "-m", "Remove synthetic source")
            silent_history_exit_probe(scanner, configuration, repository)
            # Deliberately damage only this disposable repository after committing
            # a clean working tree; no project or user history is modified.
            (repository / ".git" / "objects" / blob[:2] / blob[2:]).unlink()
        try:
            run_scan(scanner, "git", repository, configuration)
        except RuntimeError:
            return
        raise RuntimeError("Synthetic unreadable source was reported as a completed scan")


def self_test(scanner, configuration):
    """Prove rejection, historical visibility, and fail-closed source errors."""
    rejection_probe(scanner, configuration)
    rejection_probe(scanner, configuration, merge_only=True)
    for kind in ("attribute", "nul", "textconv"):
        history_visibility_probe(scanner, configuration, kind)
    source_failure_probe(scanner, configuration)
    source_failure_probe(scanner, configuration, missing_blob=True)
    print("Credential rejection, exact-exception, redaction, deleted-history, merge-only, "
          "attribute/NUL/textconv visibility, silent Git completion and unreadable-source probes passed")


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
