"""A missing canonical feature must fail the candidate before writer drain."""
import unittest
from pathlib import Path


class WebsiteFeaturePreflight(unittest.TestCase):
    def test_compatibility_preflight_precedes_stopping_live_writers(self):
        script = (Path(__file__).parents[1] / "scripts" / "deploy.sh").read_text(encoding="utf-8")
        check = script.index("await assertPlatformCompatibility();")
        drain = script.index("UPDATING=1")
        self.assertLess(check, drain)
        self.assertIn("run --rm --no-deps cloud-api", script[:check])

    def test_readiness_reuses_the_same_strict_feature_gate(self):
        source = (Path(__file__).parents[2] / "backend" / "src" / "modules" / "health" / "routes.ts").read_text(encoding="utf-8")
        self.assertIn("await assertPlatformCompatibility()", source)
        self.assertIn("reply.status(503)", source)


if __name__ == "__main__":
    unittest.main()
