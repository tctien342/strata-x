import unittest
import time
from unittest import mock
from serve.expert_monitor import ExpertMonitor


class ExpertMonitorTests(unittest.TestCase):
    def test_exact_states_counts_and_snapshot_isolation(self):
        m = ExpertMonitor()
        self.assertTrue(m.accept("ER 2 4 0,1 01233110\n", now=10))
        s = m.snapshot(now=10.5)
        self.assertEqual(s["counts"], [2, 3, 1, 2])
        self.assertEqual(s["recent_transfers"], [2])
        s["devices"][0] = 9
        s["recent_transfers"].append(99)
        self.assertEqual(m.snapshot(now=10.5)["devices"], [0, 1])
        self.assertEqual(m.snapshot(now=10.5)["recent_transfers"], [2])

    def test_malformed_packets_do_not_replace_valid_data(self):
        m = ExpertMonitor()
        m.accept("ER 1 4 0 0123", now=10)
        for line in ("ER 0 4 0 0123", "ER 48 1024 0 0", "ER 1 4 16 0123",
                     "ER 1 4 0,1 0123", "ER 1 4 0 0124", "ER x 4 0 0123", "ER 1 4 0 012"):
            self.assertFalse(m.accept(line, now=11), line)
            self.assertEqual(m.snapshot(now=10)["states"], "0123")

    def test_activity_expires_and_transfer_events_expire(self):
        m = ExpertMonitor()
        m.accept("ER 1 4 0 0123", now=10)
        m.accept("ER 1 4 0 0113", now=10.1)
        self.assertEqual(m.snapshot(now=10.6)["recent_transfers"], [2])
        self.assertEqual(m.snapshot(now=11.6)["states"], "0111")
        self.assertEqual(m.snapshot(now=11.6)["recent_transfers"], [])
        self.assertTrue(m.snapshot(now=13)["paused"])

    def test_process_generation_and_unavailable(self):
        old, new = ExpertMonitor(), ExpertMonitor()
        old.accept("ER 1 4 0 0123", now=10)
        self.assertIsNone(new.snapshot(now=10))
        self.assertIsNone(old.snapshot(alive=False, now=10))

    def test_real_engine_pump_keeps_telemetry_out_of_requests_and_resets(self):
        """STRATA-X: a real StrataEngine process - the frames are consumed by the pump, a request still works,
        and a restart replaces the monitor instead of keeping the dead engine's map."""
        import os
        import sys
        import tempfile
        import threading
        from pathlib import Path
        from serve.server import StrataEngine

        fake = r'''
import sys
print('READY 4096 stop', flush=True)
print('ER 1 4 0 0123', flush=True)
print('ER malformed', flush=True)
for line in sys.stdin:
 if line.startswith('QUIT'): break
 if line.startswith(('GEN', 'BGEN')):
  print('T 90', flush=True)
  print('DONE 1 1 0 1 stop', flush=True)
'''
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / 'native.py'
            script.write_text('#' + '!' + sys.executable + '\n' + fake)
            os.chmod(script, 0o700)
            engine = StrataEngine(str(script), [])
            try:
                deadline = time.monotonic() + 2
                while engine.expert_monitor.snapshot() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                old = engine.expert_monitor
                self.assertEqual(old.snapshot()["states"], "0123")   # malformed frame ignored
                self.assertEqual(list(engine.generate([1], 4, {}, threading.Event())), [90])
                engine.restart()
                self.assertIsNot(engine.expert_monitor, old)
                deadline = time.monotonic() + 2
                while engine.expert_monitor.snapshot() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(engine.expert_monitor.snapshot()["states"], "0123")
            finally:
                engine.close()


if __name__ == "__main__":
    unittest.main()
