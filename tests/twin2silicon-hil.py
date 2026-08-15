#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import textwrap
import time
from typing import get_args, get_origin, get_type_hints, Literal
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from benchmarks.twin2silicon.hil.process import run_command
from benchmarks.twin2silicon.hil.results import (
    CommandResult,
    RunResult,
    sha256_file,
    write_json_atomic,
)


class ResultContractTests(unittest.TestCase):
    def test_run_result_infrastructure_error_marks_execution_not_run(self):
        result = RunResult.infrastructure_error("board_identity", "wrong adapter")

        self.assertEqual(result.model_status, "not_run")
        self.assertEqual(result.compile_status, "not_run")
        self.assertEqual(result.simulator_status, "not_supported")
        self.assertEqual(result.hardware_status, "not_run")
        self.assertEqual(result.infrastructure_status, "error")
        self.assertEqual(result.failure_category, "board_identity")
        self.assertEqual(result.detail, "wrong adapter")

    def test_run_result_status_fields_use_explicit_literal_contracts(self):
        hints = get_type_hints(RunResult)
        expected_choices = {
            "model_status": ("pass", "fail", "not_run"),
            "compile_status": ("pass", "fail", "not_run"),
            "simulator_status": ("pass", "fail", "not_run", "not_supported"),
            "hardware_status": ("pass", "fail", "not_run"),
            "infrastructure_status": ("ok", "error"),
        }

        for field, choices in expected_choices.items():
            with self.subTest(field=field):
                self.assertIs(get_origin(hints[field]), Literal)
                self.assertEqual(get_args(hints[field]), choices)

    def test_sha256_file_streams_file_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "firmware.bin"
            contents = (b"LabWired\x00" * 10000) + b"tail"
            source.write_bytes(contents)

            self.assertEqual(sha256_file(source), hashlib.sha256(contents).hexdigest())

    def test_write_json_atomic_replaces_destination_with_json(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "result.json"
            destination.write_text("stale", encoding="utf-8")

            write_json_atomic(destination, {"status": "ok", "count": 2})

            self.assertEqual(
                json.loads(destination.read_text(encoding="utf-8")),
                {"status": "ok", "count": 2},
            )
            self.assertEqual(list(Path(directory).iterdir()), [destination])


class ProcessContractTests(unittest.TestCase):
    def test_run_command_timeout_captures_evidence_and_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            started = time.monotonic()
            result = run_command(
                [
                    sys.executable,
                    "-c",
                    "import sys,time; print('stdout evidence', flush=True); "
                    "print('stderr evidence', file=sys.stderr, flush=True); time.sleep(30)",
                ],
                cwd=evidence,
                stdout_path=evidence / "stdout.log",
                stderr_path=evidence / "stderr.log",
                timeout_seconds=0.1,
            )
            elapsed = time.monotonic() - started

            self.assertIsInstance(result, CommandResult)
            self.assertTrue(result.timed_out)
            self.assertNotEqual(result.returncode, 0)
            self.assertGreater(result.duration_seconds, 0)
            self.assertLess(elapsed, 2)
            self.assertEqual((evidence / "stdout.log").read_text(), "stdout evidence\n")
            self.assertEqual((evidence / "stderr.log").read_text(), "stderr evidence\n")
            self.assertEqual(result.cwd, str(evidence.resolve()))
            self.assertTrue(result.started_at_utc.endswith("Z"))
            self.assertTrue(result.ended_at_utc.endswith("Z"))

    def test_run_command_timeout_terminates_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            child_ready = evidence / "child-ready"
            child_terminated = evidence / "child-terminated"
            script = textwrap.dedent(
                f"""
                import pathlib, signal, subprocess, sys, time
                child = '''
                import pathlib, signal, time
                ready = pathlib.Path({str(child_ready)!r})
                terminated = pathlib.Path({str(child_terminated)!r})
                def stop(signum, frame):
                    terminated.write_text("terminated")
                    raise SystemExit(0)
                signal.signal(signal.SIGTERM, stop)
                ready.write_text("ready")
                while True: time.sleep(1)
                '''
                subprocess.Popen([sys.executable, "-c", child])
                while not pathlib.Path({str(child_ready)!r}).exists():
                    pass
                def stop(signum, frame):
                    while not pathlib.Path({str(child_terminated)!r}).exists():
                        pass
                    raise SystemExit(0)
                signal.signal(signal.SIGTERM, stop)
                print("child synchronized", flush=True)
                while True: time.sleep(1)
                """
            )

            result = run_command(
                [sys.executable, "-c", script],
                cwd=evidence,
                stdout_path=evidence / "group.stdout.log",
                stderr_path=evidence / "group.stderr.log",
                timeout_seconds=0.2,
            )

            self.assertTrue(result.timed_out)
            self.assertEqual((evidence / "group.stdout.log").read_text(), "child synchronized\n")
            self.assertEqual(child_terminated.read_text(), "terminated")

    def test_run_command_timeout_kills_descendant_that_ignores_sigterm(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            leader_pid_path = evidence / "leader-pid"
            child_pid_path = evidence / "ignoring-child-pid"
            script = textwrap.dedent(
                f"""
                import os, pathlib, signal, subprocess, sys, time
                pathlib.Path({str(leader_pid_path)!r}).write_text(str(os.getpid()))
                child = '''
                import os, pathlib, signal, time
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                pathlib.Path({str(child_pid_path)!r}).write_text(str(os.getpid()))
                while True: time.sleep(1)
                '''
                subprocess.Popen([sys.executable, "-c", child])
                while not pathlib.Path({str(child_pid_path)!r}).exists():
                    pass
                print("ignoring child synchronized", flush=True)
                while True: time.sleep(1)
                """
            )

            try:
                result = run_command(
                    [sys.executable, "-c", script],
                    cwd=evidence,
                    stdout_path=evidence / "ignoring.stdout.log",
                    stderr_path=evidence / "ignoring.stderr.log",
                    timeout_seconds=0.2,
                )
                leader_pid = int(leader_pid_path.read_text())
                child_pid = int(child_pid_path.read_text())

                self.assertTrue(result.timed_out)
                with self.assertRaises(ProcessLookupError):
                    os.killpg(leader_pid, 0)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if leader_pid_path.exists():
                    try:
                        os.killpg(int(leader_pid_path.read_text()), signal.SIGKILL)
                    except (PermissionError, ProcessLookupError):
                        pass


if __name__ == "__main__":
    if "-k" in sys.argv:
        pattern_index = sys.argv.index("-k") + 1
        if pattern_index < len(sys.argv) and " or " in sys.argv[pattern_index]:
            patterns = sys.argv.pop(pattern_index).split(" or ")
            sys.argv.pop(pattern_index - 1)
            for pattern in patterns:
                sys.argv.extend(("-k", pattern))
    unittest.main()
