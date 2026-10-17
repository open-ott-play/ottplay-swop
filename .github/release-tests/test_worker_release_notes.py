"""Exercise the actual Worker changelog through the publication renderer."""

import base64
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import release_control

ROOT = Path(__file__).resolve().parents[2]
SOURCE = "a" * 40


class WorkerReleaseNotesTests(unittest.TestCase):
    def test_current_notes_are_publishable_for_each_release_channel(self):
        raw = (ROOT / "CHANGELOG.md").read_bytes()
        policy = json.loads((ROOT / ".release-policy.json").read_text())
        version = json.loads((ROOT / "package.json").read_text())[
            "version"
        ].split("-", 1)[0]
        response = {
            "type": "file",
            "path": "CHANGELOG.md",
            "encoding": "base64",
            "content": base64.b64encode(raw).decode(),
            "size": len(raw),
            "sha": hashlib.sha1(
                b"blob " + str(len(raw)).encode() + b"\0" + raw,
                usedforsecurity=False,
            ).hexdigest(),
        }
        requests = []

        class SourceOnly:
            def api(self, path):
                requests.append(path)
                if path != f"contents/CHANGELOG.md?ref={SOURCE}":
                    raise AssertionError("Unexpected source read: " + path)
                return response

        for suffix in ("-beta.1", "-rc.1", ""):
            with (
                self.subTest(suffix=suffix),
                patch.object(
                    release_control,
                    "source_policy_snapshot",
                    return_value={"data": policy},
                ),
            ):
                body = release_control.release_notes(
                    SourceOnly(),
                    "v" + version + suffix,
                    SOURCE,
                    "Verified build evidence.",
                )
                self.assertIn("### Upgrade", body)
                self.assertIn("### Security", body)
                self.assertNotIn("## Unreleased", body)
        self.assertEqual(requests, [f"contents/CHANGELOG.md?ref={SOURCE}"] * 3)


if __name__ == "__main__":
    unittest.main()
