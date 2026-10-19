"""serve/test_strata_x_web.py - the Strata-X console is self-contained.

Every asset index.html names must exist beside it, and the vendored Three.js modules
the expert cube imports must be present, so an upstream merge cannot leave the page
pointing at a file that was never installed.

    python -m unittest serve.test_strata_x_web
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "serve" / "web"


class StrataXWeb(unittest.TestCase):
    def test_index_assets_exist(self):
        html = (WEB / "index.html").read_text(encoding="utf-8")
        self.assertIn("STRATA-X", html)
        refs = sorted(set(re.findall(r"web/[A-Za-z0-9._-]+", html)))
        self.assertIn("web/app-terminal-7b237e30cc8b.js", refs)
        self.assertIn("web/expert-cube-cube-19409e0630f7.js", refs)
        for ref in refs:
            self.assertTrue((WEB / ref[len("web/"):]).is_file(), ref)

    def test_cube_imports_exist(self):
        for name in ("expert-cube-cube-19409e0630f7.js", "three-r180-EffectComposer.js",
                     "three-r180-RenderPass.js", "three-r180-UnrealBloomPass.js",
                     "three-r180-OutputPass.js"):
            text = (WEB / name).read_text(encoding="utf-8")
            for dep in re.findall(r"from\s+['\"]\./([A-Za-z0-9._-]+)['\"]", text):
                self.assertTrue((WEB / dep).is_file(), f"{name} imports missing {dep}")


if __name__ == "__main__":
    unittest.main()
