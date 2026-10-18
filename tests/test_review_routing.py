"""Offline assertions for this repository's intentionally simple CODEOWNERS map."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def rules():
    result = []
    for line in (ROOT / ".github/CODEOWNERS").read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        pattern, *owners = line.split()
        result.append((pattern, owners))
    return result


def owner_for(path):
    owner = None
    for pattern, owners in rules():
        if pattern == "*" or (pattern.endswith("/") and ("/" + path).startswith(pattern)) or pattern == "/" + path:
            owner = owners
    return owner


class ReviewRoutingTests(unittest.TestCase):
    def test_valid_bounded_patterns_and_verified_maintainer(self):
        mapping = rules()
        self.assertEqual(mapping[0], ("*", ["@CompleteDotTech"]))
        self.assertEqual(len({pattern for pattern, _ in mapping}), len(mapping))
        for pattern, owners in mapping:
            self.assertTrue(pattern == "*" or pattern.startswith("/"))
            self.assertFalse(any(char in pattern for char in "![]\\"))
            if pattern != "*":
                self.assertNotIn("*", pattern)
                self.assertTrue((ROOT / pattern.strip("/")).exists(), pattern)
            self.assertEqual(owners, ["@CompleteDotTech"])

    def test_specialties_and_review_configuration_remain_routed(self):
        for path in [
            "packages/metrics/src/v1/registry.json", "packages/contracts/src/v1/schemas.ts",
            "planning/metrics-and-ingestion.json", "planning/metric-backlog-coverage.json",
            "packages/github/src/normalizers.ts", "packages/ingestion/src/index.ts",
            "apps/pipeline/src/runtime.mjs", "apps/worker/src/index.mjs",
            "apps/web/src/remote/App.tsx", "apps/service/src/app.ts",
            "apps/controls/src/server.mjs", "SECURITY.md", "infra/db/migrate.mjs",
            ".github/CODEOWNERS", ".github/workflows/future.yml", "new/unclassified/file.txt",
        ]:
            with self.subTest(path=path):
                self.assertEqual(owner_for(path), ["@CompleteDotTech"])


if __name__ == "__main__":
    unittest.main()
