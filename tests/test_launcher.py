"""Launcher path checks without installing pywebview or starting a window."""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher', ROOT / 'game.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_assets_resolve_from_another_working_directory(self):
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                self.assertEqual(Path(launcher.resource_path('index.html')), ROOT / 'index.html')
            finally:
                os.chdir(original_cwd)

    def test_frozen_assets_resolve_inside_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(sys, '_MEIPASS', directory, create=True):
                self.assertEqual(Path(launcher.resource_path('index.html')), Path(directory) / 'index.html')


if __name__ == '__main__':
    unittest.main()
