"""Dependency-free integrity checks. Run from any directory with Python 3.10+."""

import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.assets = []
        self.handlers = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        for key in ('src', 'href'):
            if key in attrs:
                self.assets.append(attrs[key])
        self.handlers.extend(value for key, value in attrs.items() if key.startswith('on'))


class ProjectChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / 'index.html').read_text(encoding='utf-8')
        cls.js = (ROOT / 'src/game.js').read_text(encoding='utf-8')
        cls.original = (ROOT / 'archive/originals/index.html').read_text(encoding='utf-8')
        cls.page = PageParser()
        cls.page.feed(cls.html)

    def test_archive_matches_uploaded_bytes(self):
        manifest = json.loads((ROOT / 'archive/manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(len(manifest), 9)
        for entry in manifest:
            with self.subTest(source=entry['source']):
                data = (ROOT / entry['path']).read_bytes()
                self.assertEqual(len(data), entry['bytes'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])

    def test_initial_extraction_preserves_game_logic(self):
        # Baseline guard: update deliberately when gameplay work starts.
        original_js = self.original.split('    <script>', 1)[1].split('    </script>', 1)[0]
        self.assertEqual(self.js, original_js)

    def test_initial_extraction_preserves_styles(self):
        original_css = self.original.split('<style>', 1)[1].split('</style>', 1)[0]
        css = (ROOT / 'src/styles.css').read_text(encoding='utf-8')
        self.assertTrue(css.startswith(original_css))
        for utility in ('.flex {', '.flex-col {', '.leading-tight {'):
            self.assertIn(utility, css)

    def test_unique_dom_ids(self):
        self.assertEqual(len(self.page.ids), len(set(self.page.ids)))

    def test_static_dom_references_exist(self):
        ids = set(re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", self.js))
        self.assertEqual(ids - set(self.page.ids), set())

    def test_html_handlers_have_functions(self):
        functions = set(re.findall(r'function\s+(\w+)\s*\(', self.js))
        for handler in self.page.handlers:
            calls = set(re.findall(r'\b(\w+)\(', handler))
            self.assertEqual(calls - functions, set(), handler)

    def test_runtime_assets_are_local(self):
        for asset in self.page.assets:
            with self.subTest(asset=asset):
                self.assertNotIn('://', asset)
                if asset.startswith('audio/') and asset.endswith('.mp3'):
                    # The user has not supplied music; silence is expected.
                    continue
                self.assertTrue((ROOT / asset).is_file(), asset)

    def test_javascript_syntax(self):
        subprocess.run(['node', '--check', str(ROOT / 'src/game.js')], check=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
