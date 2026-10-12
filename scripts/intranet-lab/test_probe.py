import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTest(unittest.TestCase):
    def check(self, result):
        devices = [{"id": name, "name": name} for name in ("pod-a", "pod-b")]
        with patch.object(probe, "wait_two", return_value=devices), \
             patch.object(probe, "run", side_effect=lambda u, t, d, c: result(d)), \
             contextlib.redirect_stdout(io.StringIO()):
            return probe.main(["probe", "http://local.invalid", "test"])

    def test_failed_output_is_not_success(self):
        with self.assertRaises(SystemExit):
            self.check(lambda d: {"ok": False, "status": "done", "exit_code": 1, "stdout": d})

    def test_incomplete_result_is_not_success(self):
        with self.assertRaises(SystemExit):
            self.check(lambda d: {"ok": True, "status": "running", "corr": d})

    def test_wrong_host_is_not_success(self):
        with self.assertRaises(SystemExit):
            self.check(lambda d: {"ok": True, "status": "done", "exit_code": 0, "stdout": "wrong-" + d})

    def test_exact_success(self):
        self.assertEqual(self.check(lambda d: {
            "ok": True, "status": "done", "exit_code": 0, "stdout": d,
        }), 0)


if __name__ == "__main__":
    unittest.main()
