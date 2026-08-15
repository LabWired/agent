#!/usr/bin/env python3
import hashlib
import contextlib
import json
import os
from pathlib import Path
import pty
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import tty
from typing import get_args, get_origin, get_type_hints, Literal
import unittest
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from benchmarks.twin2silicon.hil.process import run_command
from benchmarks.twin2silicon.hil import process as process_module
from benchmarks.twin2silicon.hil.results import (
    CommandResult,
    RunResult,
    sha256_file,
    write_json_atomic,
)
from benchmarks.twin2silicon.hil.esp32s3 import (
    BoardLock,
    BoardLockTimeout,
    Esp32S3Config,
    RegisterAssertion,
    build_openocd_command,
    capture_uart_nonce,
    evaluate_registers,
    flash_firmware,
    parse_openocd_registers,
    read_registers,
    validate_identity,
)


def executable_fixture(directory, body):
    path = Path(directory) / "fixture.py"
    path.write_text("#!/usr/bin/env python3\n" + body, encoding="utf-8")
    path.chmod(0o755)
    return path


class FixtureContractTests(unittest.TestCase):
    def test_esp32s3_gpio_hil_fixture_contract(self):
        task_root = (
            REPOSITORY_ROOT
            / "benchmarks"
            / "twin2silicon"
            / "tasks"
            / "esp32s3-gpio-hil-001"
        )
        self.assertTrue(task_root.is_dir(), f"missing fixture: {task_root}")
        task = json.loads((task_root / "task.json").read_text(encoding="utf-8"))
        oracle = json.loads(
            (task_root / task["hidden_oracle"]).read_text(encoding="utf-8")
        )

        self.assertEqual(task["schema_version"], "1.0")
        self.assertEqual(task["id"], "esp32s3-gpio-hil-001")
        self.assertEqual(task["board"], "esp32-s3-devkitc-1")
        self.assertEqual(task["framework"], "espidf")
        self.assertEqual(task["budgets"]["model_tokens"], 50000)
        self.assertEqual(task["budgets"]["diagnostic_hil_runs"], 0)
        self.assertEqual(oracle["schema_version"], "1.0")
        self.assertEqual(oracle["uart"]["ready_prefix"], "LABWIRED_READY:")
        self.assertEqual(
            oracle["register_assertions"],
            [
                {
                    "name": "gpio2_output_enabled",
                    "address": "0x60004020",
                    "mask": "0x00000004",
                    "expected": "0x00000004",
                },
                {
                    "name": "gpio2_output_high",
                    "address": "0x60004004",
                    "mask": "0x00000004",
                    "expected": "0x00000004",
                },
            ],
        )

        public_files = sorted(
            path for path in (task_root / task["public_dir"]).rglob("*") if path.is_file()
        )
        expected_public_files = {
            "README.md",
            "firmware/include/run_nonce.h",
            "firmware/platformio.ini",
            "firmware/sdkconfig.defaults",
            "firmware/src/main.c",
        }
        self.assertEqual(
            {str(path.relative_to(task_root / task["public_dir"])) for path in public_files},
            expected_public_files,
        )
        public_text = "\n".join(path.read_text(encoding="utf-8") for path in public_files)
        for hidden_detail in (
            "0x60004020",
            "0x60004004",
            "0x00000004",
            "esp32s3-builtin.cfg",
            "openocd",
            "mdw",
        ):
            with self.subTest(hidden_detail=hidden_detail):
                self.assertNotIn(hidden_detail, public_text.lower())
        main_source = (task_root / "public" / "firmware" / "src" / "main.c").read_text(
            encoding="utf-8"
        )
        self.assertIn("gpio_set_direction(TEST_GPIO, GPIO_MODE_INPUT)", main_source)
        sdkconfig_defaults = (
            task_root / "public" / "firmware" / "sdkconfig.defaults"
        ).read_text(encoding="utf-8")
        self.assertIn("# CONFIG_ESP_CONSOLE_NONE is not set", sdkconfig_defaults)
        self.assertNotIn("CONFIG_ESP_CONSOLE_UART_NONE", sdkconfig_defaults)


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
    def test_streaming_redaction_handles_cross_chunk_secret_and_oversize_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); crossed=root/'crossed'; secret=b'CROSS_BOUNDARY_SECRET'
            crossed.write_bytes(b'A'*(1024*1024-len(secret)//2)+secret+b'Z')
            self.assertIsNone(process_module._redact_logs((str(crossed),),(secret,)))
            self.assertNotIn(secret,crossed.read_bytes()); self.assertIn(b'[REDACTED]',crossed.read_bytes())
            huge=root/'huge';
            with huge.open('wb') as output: output.truncate(20*1024*1024)
            self.assertEqual(process_module._redact_logs((str(huge),),(b'x',)),"evidence_log_too_large")
            self.assertEqual(huge.read_bytes(),b'[EVIDENCE LOG TOO LARGE]\n')

    def test_successful_leader_cannot_leave_mutating_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory); child_path = evidence / "child"; mutation = evidence / "mutation"
            script = textwrap.dedent(f"""
                import pathlib, subprocess, sys
                child = '''
                import os, pathlib, time
                pathlib.Path({str(child_path)!r}).write_text(str(os.getpid()))
                time.sleep(.4)
                pathlib.Path({str(mutation)!r}).write_text('late')
                time.sleep(30)
                '''
                subprocess.Popen([sys.executable, '-c', child])
                while not pathlib.Path({str(child_path)!r}).exists(): pass
                print('leader done')
            """)
            result = run_command([sys.executable, "-c", script], cwd=evidence,
                                 stdout_path=evidence / "o", stderr_path=evidence / "e", timeout_seconds=2)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.cleanup_error, "unexpected_descendant_processes")
            with self.assertRaises(ProcessLookupError): os.kill(int(child_path.read_text()), 0)
            time.sleep(.5)
            self.assertFalse(mutation.exists())

    def test_run_command_interrupt_terminates_process_group_before_reraising(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            pid_path = evidence / "pid"
            timer = threading.Timer(.15, lambda: os.kill(os.getpid(), signal.SIGINT))
            timer.start()
            try:
                with self.assertRaises(KeyboardInterrupt):
                    run_command([sys.executable, "-c", f"import os,pathlib,time; pathlib.Path({str(pid_path)!r}).write_text(str(os.getpid())); time.sleep(30)"],
                                cwd=evidence, stdout_path=evidence / "o", stderr_path=evidence / "e", timeout_seconds=30)
                child = int(pid_path.read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(child, 0)
            finally:
                timer.cancel()
                if pid_path.exists():
                    try: os.kill(int(pid_path.read_text()), signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_run_command_redacts_exact_bytes_before_interrupt_reraises(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory); output = evidence / "o"
            timer = threading.Timer(.15, lambda: os.kill(os.getpid(), signal.SIGINT)); timer.start()
            try:
                with self.assertRaises(KeyboardInterrupt):
                    run_command([sys.executable, "-c", "import time; print('TOKEN_SENTINEL', flush=True); time.sleep(30)"],
                                cwd=evidence, stdout_path=output, stderr_path=evidence / "e", timeout_seconds=30,
                                redact_values=(b"TOKEN_SENTINEL",))
            finally: timer.cancel()
            self.assertEqual(output.read_text(), "[REDACTED]\n")

    def test_interrupted_sparse_log_is_replaced_boundedly(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence=Path(directory); output=evidence/'o'
            timer=threading.Timer(.15,lambda: os.kill(os.getpid(),signal.SIGINT)); timer.start()
            try:
                with self.assertRaises(KeyboardInterrupt):
                    run_command([sys.executable,'-c',"import os,time; os.lseek(1,20*1024*1024,0); os.write(1,b'x'); time.sleep(30)"],
                        cwd=evidence,stdout_path=output,stderr_path=evidence/'e',timeout_seconds=30,redact_values=(b'secret',))
            finally: timer.cancel()
            self.assertEqual(output.read_bytes(),b'[EVIDENCE LOG TOO LARGE]\n')

    def test_run_command_interrupt_kills_sigterm_ignoring_descendant_after_leader_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory); child_path = evidence / "child"
            script = textwrap.dedent(f"""
                import pathlib, signal, subprocess, sys, time
                child = '''
                import os, pathlib, signal, time
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                pathlib.Path({str(child_path)!r}).write_text(str(os.getpid()))
                while True: time.sleep(1)
                '''
                subprocess.Popen([sys.executable, '-c', child])
                while not pathlib.Path({str(child_path)!r}).exists(): pass
                signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
                while True: time.sleep(1)
            """)
            timer = threading.Timer(.15, lambda: os.kill(os.getpid(), signal.SIGINT)); timer.start()
            try:
                with self.assertRaises(KeyboardInterrupt):
                    run_command([sys.executable, "-c", script], cwd=evidence,
                                stdout_path=evidence / "o", stderr_path=evidence / "e", timeout_seconds=30)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(child_path.read_text()), 0)
            finally:
                timer.cancel()
                if child_path.exists():
                    try: os.kill(int(child_path.read_text()), signal.SIGKILL)
                    except ProcessLookupError: pass

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
            self.assertIsNone(result.cleanup_error)

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

    def test_run_command_reports_cleanup_error_when_leader_cannot_be_reaped(self):
        class UnreapableProcess:
            pid = 424242
            returncode = None

            def __init__(self):
                self.wait_timeouts = []

            def communicate(self, timeout):
                raise subprocess.TimeoutExpired(("stuck-tool",), timeout)

            def wait(self, timeout=None):
                self.wait_timeouts.append(timeout)
                if timeout is None:
                    raise AssertionError("run_command used an unbounded wait")
                raise subprocess.TimeoutExpired(("stuck-tool",), timeout)

        def fake_killpg(process_group_id, signal_number):
            if signal_number == 0:
                raise ProcessLookupError

        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            fake_process = UnreapableProcess()
            started = time.monotonic()
            with mock.patch.object(process_module.subprocess, "Popen", return_value=fake_process), mock.patch.object(
                process_module.os, "killpg", side_effect=fake_killpg
            ):
                result = run_command(
                    ["stuck-tool"],
                    cwd=evidence,
                    stdout_path=evidence / "stuck.stdout.log",
                    stderr_path=evidence / "stuck.stderr.log",
                    timeout_seconds=0.01,
                )

            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(result.cleanup_error, "process_group_did_not_exit")
            self.assertTrue(fake_process.wait_timeouts)
            self.assertNotIn(None, fake_process.wait_timeouts)

    def test_run_command_reports_cleanup_error_when_descendant_remains_after_reap(self):
        class ReapedLeader:
            pid = 424243
            returncode = -signal.SIGTERM

            def communicate(self, timeout):
                raise subprocess.TimeoutExpired(("stuck-descendant",), timeout)

            def wait(self, timeout):
                return self.returncode

        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            started = time.monotonic()
            with mock.patch.object(process_module.subprocess, "Popen", return_value=ReapedLeader()), mock.patch.object(
                process_module.os, "killpg"
            ), mock.patch.object(process_module, "_process_group_exists", return_value=True):
                result = run_command(
                    ["stuck-descendant"],
                    cwd=evidence,
                    stdout_path=evidence / "descendant.stdout.log",
                    stderr_path=evidence / "descendant.stderr.log",
                    timeout_seconds=0.01,
                )

            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(result.cleanup_error, "process_group_did_not_exit")


class Esp32S3ConfigTests(unittest.TestCase):
    def test_parses_shipped_oracle_exactly(self):
        oracle_path = (REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/hidden/hil-oracle.json")
        config = Esp32S3Config.from_oracle(json.loads(oracle_path.read_text()))
        self.assertEqual(config.uart_ready_prefix, "LABWIRED_READY:")
        self.assertEqual((config.uart_baud, config.uart_timeout_seconds), (115200, 30))
        self.assertEqual(config.identity_command, ("__LABWIRED_IDENTITY_RUNNER__",))
        self.assertEqual((config.identity_expected_board, config.identity_timeout_seconds),
                         ("esp32-s3-devkitc-1", 10))
        self.assertEqual((config.flash_target, config.flash_artifact, config.flash_timeout_seconds),
                         ("upload", ".pio/build/esp32s3/firmware.bin", 120))
        self.assertEqual((config.openocd_board_config, config.openocd_startup_timeout_seconds,
                          config.openocd_command_timeout_seconds), ("esp32s3-builtin.cfg", 20, 10))
        self.assertEqual((config.platformio_project_dir, config.platformio_environment),
                         ("public/firmware", "esp32s3"))
        self.assertEqual(len(config.assertions), 2)

    def test_parses_valid_oracle_and_hex_register_values(self):
        config = Esp32S3Config.from_oracle(
            {
                "uart": {"ready_prefix": "READY:", "baud": 115200, "timeout_seconds": 1},
                "identity": {"command": ["identity"], "expected_board": "board", "timeout_seconds": 0},
                "flash": {"target": "upload", "artifact": "firmware.bin", "timeout_seconds": 0},
                "openocd": {"board_config": "board.cfg", "startup_timeout_seconds": 0,
                            "command_timeout_seconds": 0},
                "register_assertions": [
                    {"name": "gpio", "address": "0x60004020", "mask": "0x4", "expected": "0x4"}
                ],
            }
        )
        self.assertEqual(config.assertions[0].address, 0x60004020)
        self.assertEqual(config.assertions[0].mask, 4)

    def test_rejects_invalid_bounds_alignment_duplicates_and_names(self):
        good = {"name": "gpio", "address": "0x60004020", "mask": "0x4", "expected": "0x4"}
        bad = [
            {**good, "address": "-1"},
            {**good, "address": "0x60004021"},
            {**good, "mask": "0x100000000"},
            {**good, "expected": "xyz"},
            {**good, "expected": "4"},
            {**good, "mask": 1.5},
            {**good, "name": "gpio; shutdown"},
        ]
        for record in bad:
            with self.subTest(record=record), self.assertRaises((TypeError, ValueError)):
                RegisterAssertion.from_json(record)
        with self.assertRaises(ValueError):
            Esp32S3Config.from_oracle({
                "uart": {"ready_prefix": "READY:", "baud": 115200, "timeout_seconds": 1},
                "identity": {"command": ["id"], "expected_board": "board", "timeout_seconds": 0},
                "flash": {"target": "upload", "artifact": "fw", "timeout_seconds": 0},
                "openocd": {"board_config": "cfg", "startup_timeout_seconds": 0, "command_timeout_seconds": 0},
                "register_assertions": [good, {**good, "address": "0x60004024"}],
            })
        with self.assertRaises(ValueError):
            Esp32S3Config.from_oracle({
                "uart": {"ready_prefix": "READY:", "baud": 115200, "timeout_seconds": 1},
                "identity": {"command": ["id"], "expected_board": "board", "timeout_seconds": 0},
                "flash": {"target": "upload", "artifact": "fw", "timeout_seconds": 0},
                "openocd": {"board_config": "cfg", "startup_timeout_seconds": 0, "command_timeout_seconds": 0},
                "register_assertions": [good, {**good, "name": "gpio2"}],
            })

    def test_rejects_empty_configuration_assertions_and_nonfinite_timeout(self):
        for timeout in (float("nan"), float("inf")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                Esp32S3Config.from_oracle({
                    "uart": {"ready_prefix": "READY:", "baud": 115200, "timeout_seconds": timeout},
                    "identity": {"command": ["id"], "expected_board": "board", "timeout_seconds": 0},
                    "flash": {"target": "upload", "artifact": "fw", "timeout_seconds": 0},
                    "openocd": {"board_config": "cfg", "startup_timeout_seconds": 0, "command_timeout_seconds": 0},
                    "register_assertions": [{"name": "gpio", "address": "0x4", "mask": "0x4", "expected": "0x4"}],
                })
        with self.assertRaises(ValueError):
            Esp32S3Config.from_oracle({
                "uart": {"ready_prefix": "", "baud": 115200, "timeout_seconds": 1},
                "identity": {"command": [], "expected_board": "", "timeout_seconds": 0},
                "flash": {"target": "", "artifact": "", "timeout_seconds": 0},
                "openocd": {"board_config": "", "startup_timeout_seconds": 0, "command_timeout_seconds": 0},
                "register_assertions": [],
            })


class BoardIdentityAndFlashTests(unittest.TestCase):
    def test_exactly_one_configured_serial_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            tool = executable_fixture(directory, "print('  JTAG-1  ')\n")
            result = validate_identity([tool], "JTAG-1", cwd=directory, evidence_dir=directory, timeout_seconds=1)
            self.assertEqual((result.status, result.category), ("pass", None))

    def test_absent_wrong_and_duplicate_serials_are_infrastructure_before_flash(self):
        for output in ("", "OTHER\\n", "JTAG-1\\nJTAG-1\\n"):
            with self.subTest(output=output), tempfile.TemporaryDirectory() as directory:
                marker = Path(directory) / "flashed"
                tool = executable_fixture(directory, f"print({output!r}, end='')\n")
                result = validate_identity([tool], "JTAG-1", cwd=directory, evidence_dir=directory, timeout_seconds=1)
                self.assertEqual((result.status, result.category), ("infrastructure_error", "board_identity"))
                flash = executable_fixture(directory, f"from pathlib import Path; Path({str(marker)!r}).write_text('flashed')\n")
                with self.assertRaises(ValueError):
                    flash_firmware([flash], cwd=directory, evidence_dir=directory, timeout_seconds=1,
                                   identity_validated=False)
                self.assertFalse(marker.exists())

    def test_identity_success_then_flash_executes_in_order(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "flashed"
            identity_tool = executable_fixture(directory, "print('JTAG-1')\n")
            identity = validate_identity([identity_tool], "JTAG-1", cwd=directory,
                                         evidence_dir=directory, timeout_seconds=1)
            flash_tool = Path(directory) / "flash.py"
            flash_tool.write_text("#!/usr/bin/env python3\nfrom pathlib import Path\nPath(%r).write_text('flashed')\n" % str(marker))
            flash_tool.chmod(0o755)
            flashed = flash_firmware([flash_tool], cwd=directory, evidence_dir=directory,
                                     timeout_seconds=1, identity_validated=identity.status == "pass")
            self.assertEqual(flashed.status, "pass")
            self.assertEqual(marker.read_text(), "flashed")

    def test_identity_tool_timeout_nonzero_and_cleanup_are_infrastructure(self):
        with tempfile.TemporaryDirectory() as directory:
            slow = executable_fixture(directory, "import time; time.sleep(30)\n")
            result = validate_identity([slow], "JTAG-1", cwd=directory, evidence_dir=directory, timeout_seconds=.05)
            self.assertEqual(result.status, "infrastructure_error")
        with tempfile.TemporaryDirectory() as directory:
            failed = executable_fixture(directory, "raise SystemExit(3)\n")
            result = validate_identity([failed], "JTAG-1", cwd=directory, evidence_dir=directory, timeout_seconds=1)
            self.assertEqual((result.status, result.category), ("infrastructure_error", "board_identity"))
        fake = CommandResult(("x",), "/", 0, False, "", "", 0, "/tmp/o", "/tmp/e", "cleanup")
        with tempfile.TemporaryDirectory() as directory:
            result = validate_identity(["x"], "JTAG-1", cwd=directory, evidence_dir=directory,
                                       timeout_seconds=1, runner=lambda *a, **k: fake)
        self.assertEqual((result.status, result.category), ("infrastructure_error", "board_identity"))

    def test_non_utf8_identity_output_is_infrastructure(self):
        with tempfile.TemporaryDirectory() as directory:
            tool = executable_fixture(directory, "import sys; sys.stdout.buffer.write(b'\\xff\\xfe')\n")
            result = validate_identity([tool], "JTAG-1", cwd=directory, evidence_dir=directory,
                                       timeout_seconds=1)
        self.assertEqual((result.status, result.category), ("infrastructure_error", "board_identity"))

    def test_command_launch_errors_are_infrastructure(self):
        def unavailable(*args, **kwargs):
            raise FileNotFoundError("tool missing")
        with tempfile.TemporaryDirectory() as directory:
            identity = validate_identity(["missing"], "JTAG-1", cwd=directory, evidence_dir=directory,
                                         timeout_seconds=1, runner=unavailable)
            flash = flash_firmware(["missing"], cwd=directory, evidence_dir=directory,
                                   timeout_seconds=1, identity_validated=True, runner=unavailable)
        self.assertEqual(identity.status, "infrastructure_error")
        self.assertEqual(flash.status, "infrastructure_error")

    def test_flash_classifies_nonzero_as_hardware_and_timeout_cleanup_as_infrastructure(self):
        def result(code=0, timed_out=False, cleanup=None):
            return CommandResult(("flash",), "/", code, timed_out, "", "", 0, "/tmp/o", "/tmp/e", cleanup)
        with tempfile.TemporaryDirectory() as directory:
            failed = flash_firmware(["flash"], cwd=directory, evidence_dir=directory, timeout_seconds=1,
                                    identity_validated=True, runner=lambda *a, **k: result(2))
            timeout = flash_firmware(["flash"], cwd=directory, evidence_dir=directory, timeout_seconds=1,
                                     identity_validated=True, runner=lambda *a, **k: result(-15, True))
            cleanup = flash_firmware(["flash"], cwd=directory, evidence_dir=directory, timeout_seconds=1,
                                     identity_validated=True, runner=lambda *a, **k: result(0, False, "stuck"))
        self.assertEqual((failed.status, failed.category), ("hardware_fail", "flash"))
        self.assertEqual(timeout.status, "infrastructure_error")
        self.assertEqual(cleanup.status, "infrastructure_error")
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            flash_firmware(["flash"], cwd=directory, evidence_dir=directory, timeout_seconds=1,
                           identity_validated=False)


class BoardLockTests(unittest.TestCase):
    def test_lock_is_identity_keyed_bounded_and_released_normally(self):
        with tempfile.TemporaryDirectory() as directory:
            first = BoardLock(directory, "usb/serial:one", timeout_seconds=.1)
            with first:
                self.assertIn("usb_serial_one", first.path.name)
                started = time.monotonic()
                with self.assertRaises(BoardLockTimeout):
                    with BoardLock(directory, "usb/serial:one", timeout_seconds=.05):
                        pass
                self.assertLess(time.monotonic() - started, .5)
            with BoardLock(directory, "usb/serial:one", timeout_seconds=.1):
                pass

    def test_lock_releases_after_exception_and_stale_metadata_does_not_claim_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = BoardLock(directory, "JTAG-1", timeout_seconds=.1)
            lock.path.parent.mkdir(parents=True, exist_ok=True)
            lock.path.write_text('{"pid": 999999, "identity": "stale"}')
            with self.assertRaises(RuntimeError):
                with lock:
                    metadata = json.loads(lock.path.read_text())
                    self.assertEqual(metadata["identity"], "JTAG-1")
                    raise RuntimeError("candidate failed")
            with BoardLock(directory, "JTAG-1", timeout_seconds=.1):
                pass

    def test_lock_releases_if_metadata_persistence_fails_and_rejects_nonfinite_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch("benchmarks.twin2silicon.hil.esp32s3.os.fsync", side_effect=OSError("disk")):
                with self.assertRaises(OSError):
                    with BoardLock(directory, "JTAG-1", timeout_seconds=.1):
                        pass
            with BoardLock(directory, "JTAG-1", timeout_seconds=.1):
                pass
            for timeout in (float("nan"), float("inf")):
                with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                    BoardLock(directory, "JTAG-1", timeout_seconds=timeout)


class UartNonceTests(unittest.TestCase):
    def _capture(self, chunks, nonce="current", timeout=.2, max_bytes=64):
        master, slave = pty.openpty()
        device = os.ttyname(slave)
        tty.setraw(slave)
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "uart.log"
            started = threading.Event()
            def writer():
                started.wait()
                for chunk in chunks:
                    os.write(master, chunk)
            thread = threading.Thread(target=writer)
            thread.start()
            started.set()
            try:
                result = capture_uart_nonce(device, 115200, nonce, timeout, log, max_bytes=max_bytes)
            finally:
                thread.join(1)
                os.close(master)
                os.close(slave)
            return result, log.read_bytes()

    def test_accepts_only_exact_current_nonce_as_complete_line_and_logs_raw_bytes(self):
        result, raw = self._capture([b"boot\r\nLABWIRED_READY:current\r", b"\n"])
        self.assertTrue(result.matched)
        self.assertEqual(raw, b"boot\r\nLABWIRED_READY:current\r\n")

    def test_rejects_absent_wrong_stale_or_incomplete_nonce_with_bounded_evidence(self):
        for chunks in ([b"boot\n"], [b"LABWIRED_READY:wrong\n"],
                       [b"LABWIRED_READY:stale\n"], [b"LABWIRED_READY:current"]):
            with self.subTest(chunks=chunks):
                started = time.monotonic()
                result, raw = self._capture(chunks, timeout=.05)
                self.assertFalse(result.matched)
                self.assertLess(time.monotonic() - started, .5)
                self.assertLessEqual(len(raw), 64)

    def test_cancellation_stops_capture_and_closes_stable_log(self):
        master, slave = pty.openpty()
        device = os.ttyname(slave)
        tty.setraw(slave)
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "uart.log"
            cancel = threading.Event()
            started = threading.Event()
            result = []
            thread = threading.Thread(target=lambda: result.append(
                capture_uart_nonce(device, 115200, "nonce", 30, log, cancel_event=cancel,
                                   started_event=started)))
            thread.start()
            self.assertTrue(started.wait(.5))
            cancel.set()
            thread.join(.5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result[0].termination_reason, "cancelled")
            before = log.read_bytes()
            time.sleep(.05)
            self.assertEqual(log.read_bytes(), before)
        os.close(master)
        os.close(slave)

    def test_rejects_unsupported_baud_and_closes_opened_fd(self):
        master, slave = pty.openpty()
        device = os.ttyname(slave)
        os.close(slave)
        real_close = os.close
        closed = []
        with tempfile.TemporaryDirectory() as directory, mock.patch("benchmarks.twin2silicon.hil.esp32s3.os.close", side_effect=lambda fd: (closed.append(fd), real_close(fd))[1]):
            with self.assertRaises(ValueError):
                capture_uart_nonce(device, 12345, "n", .01, Path(directory) / "log")
        real_close(master)
        self.assertTrue(closed)

    def test_timeout_closes_the_opened_uart_fd(self):
        master, slave = pty.openpty()
        device = os.ttyname(slave)
        opened = []
        real_open = os.open
        with tempfile.TemporaryDirectory() as directory, mock.patch(
            "benchmarks.twin2silicon.hil.esp32s3.os.open",
            side_effect=lambda *args, **kwargs: (lambda fd: (opened.append(fd), fd)[1])(real_open(*args, **kwargs)),
        ):
            result = capture_uart_nonce(device, 115200, "never", .01, Path(directory) / "uart.log")
        os.close(master)
        os.close(slave)
        self.assertFalse(result.matched)
        self.assertTrue(result.timed_out)
        self.assertEqual(result.termination_reason, "timeout")
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError) as error:
            os.fstat(opened[0])
        self.assertEqual(error.exception.errno, 9)

    def test_max_bytes_exhaustion_is_not_reported_as_timeout(self):
        result, raw = self._capture([b"1234567890"], timeout=1, max_bytes=10)
        self.assertFalse(result.matched)
        self.assertFalse(result.timed_out)
        self.assertEqual(result.termination_reason, "max_bytes")
        self.assertEqual(raw, b"1234567890")


class OpenOcdEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.assertions = (
            RegisterAssertion("enable", 0x60004020, 4, 4),
            RegisterAssertion("high", 0x60004004, 4, 4),
        )

    def test_command_is_argv_and_requests_marked_records_at_fixed_speed(self):
        command = build_openocd_command("openocd", "board.cfg", "JTAG-1", self.assertions)
        self.assertEqual(command, ["openocd", "-f", "board.cfg", "-c",
            'adapter serial JTAG-1; adapter speed 4000; init; reset run; sleep 750; halt; '
            'echo "@@REG enable 0x60004020"; mdw 0x60004020 1; '
            'echo "@@REG high 0x60004004"; mdw 0x60004004 1; exit'])

    def test_empty_assertions_are_rejected_by_all_register_paths(self):
        with self.assertRaises(ValueError):
            build_openocd_command("openocd", "board.cfg", "serial", ())
        with self.assertRaises(ValueError):
            parse_openocd_registers("", ())
        with self.assertRaises(ValueError):
            evaluate_registers({}, ())

    def test_parser_accepts_only_immediately_paired_canonical_requested_records(self):
        text = "noise\n@@REG enable 0x60004020\n0x60004020: 0x00000004\n@@REG high 0x60004004\n0x60004004: 0x00000004\n"
        self.assertEqual(parse_openocd_registers(text, self.assertions), {"enable": 4, "high": 4})
        invalid = [
            text.replace("0x60004020: 0x00000004", "noise\n0x60004020: 0x00000004"),
            text + "@@REG enable 0x60004020\n0x60004020: 0x00000004\n",
            text.replace("enable", "other"),
            text.replace("@@REG enable 0x60004020", "@@REG enable 0x60004024"),
            text.replace("0x60004020: 0x00000004", "60004020 = 4"),
            text.replace("@@REG enable 0x60004020", "@@REG enable not-an-address"),
            text + "@@REG malformed\n",
            text + "Error: target not halted\n",
            text.split("@@REG high")[0],
        ]
        for evidence in invalid:
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                parse_openocd_registers(evidence, self.assertions)

    def test_parser_accepts_real_espressif_bare_eight_digit_mdw_value(self):
        text = "@@REG enable 0x60004020\n0x60004020: 00000004\n@@REG high 0x60004004\n0x60004004: 00000004\n"
        self.assertEqual(parse_openocd_registers(text, self.assertions), {"enable": 4, "high": 4})

    def test_masked_mismatch_fails_and_all_assertions_pass(self):
        passing = evaluate_registers({"enable": 0x104, "high": 4}, self.assertions)
        failing = evaluate_registers({"enable": 0, "high": 4}, self.assertions)
        self.assertEqual(passing.status, "pass")
        self.assertEqual(failing.status, "hardware_fail")
        self.assertFalse(failing.observations[0].passed)

    def test_evaluation_rejects_non_uint32_observed_values(self):
        for value in (True, -1, 0x100000000, 1.5, "4"):
            with self.subTest(value=value), self.assertRaises((TypeError, ValueError)):
                evaluate_registers({"enable": value, "high": 4}, self.assertions)


class OpenOcdExecutionTests(unittest.TestCase):
    def setUp(self):
        self.assertions = (RegisterAssertion("gpio", 0x60004020, 4, 4),)

    def _run(self, directory, body, timeout=1):
        tool = executable_fixture(directory, body)
        return read_registers(tool, "board.cfg", "JTAG-1", self.assertions, cwd=directory,
                              evidence_dir=directory, timeout_seconds=timeout)

    def test_reads_openocd_stderr_and_returns_typed_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run(directory, "import sys\nprint('@@REG gpio 0x60004020', file=sys.stderr)\nprint('0x60004020: 0x00000004', file=sys.stderr)\n")
        self.assertEqual((result.status, result.category), ("pass", None))
        self.assertEqual(result.observed, {"gpio": 4})
        self.assertEqual(result.evaluation.status, "pass")
        self.assertEqual(result.command_result.returncode, 0)

    def test_classifies_nonzero_timeout_cleanup_launch_and_parse_as_infrastructure(self):
        with tempfile.TemporaryDirectory() as directory:
            nonzero = self._run(directory, "raise SystemExit(2)\n")
            timeout = self._run(directory, "import time; time.sleep(30)\n", timeout=.05)
            malformed = self._run(directory, "import sys; print('@@REG gpio bad', file=sys.stderr)\n")
            fake = CommandResult(("x",), "/", 0, False, "", "", 0, "/tmp/o", "/tmp/e", "stuck")
            cleanup = read_registers("x", "c", "s", self.assertions, cwd=directory,
                                     evidence_dir=directory, timeout_seconds=1, runner=lambda *a, **k: fake)
            launch = read_registers("x", "c", "s", self.assertions, cwd=directory,
                                    evidence_dir=directory, timeout_seconds=1,
                                    runner=lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("missing")))
        for result in (nonzero, timeout, malformed, cleanup, launch):
            with self.subTest(result=result):
                self.assertEqual((result.status, result.category), ("infrastructure_error", "openocd"))

    def test_timeout_terminates_openocd_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            terminated = Path(directory) / "child-terminated"
            ready = Path(directory) / "child-ready"
            body = textwrap.dedent(f"""
                import pathlib, signal, subprocess, sys, time
                child = '''
                import pathlib, signal, time
                terminated = pathlib.Path({str(terminated)!r})
                def stop(signum, frame):
                    terminated.write_text("terminated")
                    raise SystemExit(0)
                signal.signal(signal.SIGTERM, stop)
                pathlib.Path({str(ready)!r}).write_text("ready")
                while True: time.sleep(1)
                '''
                subprocess.Popen([sys.executable, "-c", child])
                while not pathlib.Path({str(ready)!r}).exists(): pass
                def stop(signum, frame):
                    while not pathlib.Path({str(terminated)!r}).exists(): pass
                    raise SystemExit(0)
                signal.signal(signal.SIGTERM, stop)
                print("ready", flush=True)
                while True: time.sleep(1)
            """)
            result = self._run(directory, body, timeout=.5)
            self.assertEqual(result.status, "infrastructure_error")
            self.assertEqual(terminated.read_text(), "terminated")


class HilOrchestrationTests(unittest.TestCase):
    def _run_cli(self, *arguments, env=None):
        return subprocess.run(
            [sys.executable, str(REPOSITORY_ROOT / "benchmarks/twin2silicon/run_hil.py"), *map(str, arguments)],
            cwd=REPOSITORY_ROOT, text=True, capture_output=True, env=env,
        )

    def _short_task(self):
        source = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        return source

    def test_evaluate_only_prepares_isolated_workspace_and_records_compile_failure(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate"
            shutil.copytree(task / "public", candidate)
            invocations = root / "pio-invocations"
            tool_dir = root / "pio"
            tool_dir.mkdir()
            platformio = executable_fixture(tool_dir, textwrap.dedent(f"""
                import sys
                from pathlib import Path
                if '--version' in sys.argv: print('pio fixture 1'); raise SystemExit(0)
                with Path({str(invocations)!r}).open('a') as output:
                    output.write(json.dumps(sys.argv[1:]) + '\\n')
                raise SystemExit(0 if 'clean' in sys.argv else 1)
            """).replace("import sys\n", "import json, sys\n"))
            identity = executable_fixture(root, "raise AssertionError('identity must not run')\n")
            run_dir = root / "run"
            result = self._run_cli(
                task, "--run-dir", run_dir, "--evaluate-only", "--candidate", candidate,
                "--jtag-serial", "JTAG-1", "--uart-device", "/dev/null",
                "--openocd", identity, "--platformio", platformio,
                "--identity-command-json", json.dumps([str(identity)]),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((run_dir / "run.json").read_text())
            self.assertEqual((manifest["compile_status"], manifest["hardware_status"]), ("fail", "not_run"))
            pio_commands = [json.loads(line) for line in invocations.read_text().splitlines()]
            self.assertEqual(len(pio_commands), 2)
            self.assertEqual(pio_commands[0][-2:], ["--target", "clean"])
            nonce_header = (run_dir / "workspace/firmware/include/run_nonce.h").read_text()
            nonce = nonce_header.split('"')[1]
            self.assertRegex(nonce, r"^[0-9a-f]{32}$")
            self.assertNotIn("hidden", {path.name for path in (run_dir / "workspace").rglob("*")})
            self.assertNotEqual(manifest["hashes"]["source_initial"], "")
            self.assertEqual(manifest["hashes"]["source_initial"], manifest["hashes"]["source_final"])
            self.assertTrue(all(not Path(path).is_absolute() for path in manifest["artifacts"]))
            self.assertEqual(self._run_cli(
                task, "--run-dir", run_dir, "--evaluate-only", "--candidate", candidate,
                "--jtag-serial", "JTAG-1", "--uart-device", "/dev/null", "--openocd", identity,
            ).returncode, 2)

    def test_usage_cost_is_exact_and_rejects_boolean_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            usage = root / "usage.json"
            usage.write_text(json.dumps({
                "requests": 2, "tokens": {"fresh_input": 100, "cached_input": 200,
                "output": 300, "reasoning": 40}, "final_context_tokens": 55,
                "latency_seconds": 1.25, "provider": "fixture", "model": "m",
                "rates_usd_per_million": {"fresh_input": 10, "cached_input": 1, "output": 20},
                "schema_version": "1.0", "price_source": "fixture", "price_effective_date": "2026-01-01"
            }))
            sys.path.insert(0, str(REPOSITORY_ROOT / "benchmarks/twin2silicon"))
            import run_hil
            cost = run_hil.parse_usage(usage)
            self.assertEqual(cost["cost_usd"], 0.0072)
            usage.write_text(usage.read_text().replace('"requests": 2', '"requests": true'))
            with self.assertRaises(ValueError):
                run_hil.parse_usage(usage)

    def test_usage_schema_rejects_missing_extra_and_legacy_price_date(self):
        sys.path.insert(0, str(REPOSITORY_ROOT / "benchmarks/twin2silicon"))
        import run_hil
        base = {"schema_version": "1.0", "requests": 1,
                "tokens": {"fresh_input": 1, "cached_input": 2, "output": 3, "reasoning": 4},
                "final_context_tokens": 1, "latency_seconds": 1, "provider": "p", "model": "m",
                "rates_usd_per_million": {"fresh_input": 1, "cached_input": 1, "output": 1},
                "price_source": "s", "price_effective_date": "2026-01-01"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "usage.json"
            for invalid in ({**base, "extra": 1}, {key: value for key, value in base.items() if key != "requests"},
                            {**base, "price_date": "legacy"}):
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    run_hil.parse_usage(path)

    def test_finalizer_uses_total_monotonic_wall_time_not_provider_latency(self):
        sys.path.insert(0, str(REPOSITORY_ROOT / "benchmarks/twin2silicon"))
        import run_hil
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "slow.log"; artifact.write_text("evidence")
            manifest = {"model_status": "not_run", "compile_status": "not_run",
                        "simulator_status": "not_supported", "hardware_status": "not_run",
                        "infrastructure_status": "ok", "termination": "completed", "failure_category": None,
                        "uart": None, "register_assertions": [], "hashes": {}, "run": {}, "latency_seconds": .001,
                        "budget_validity": {"wall_time_seconds": {"configured": .01, "observed": None, "within_budget": None}}}
            real_hash = run_hil._safe_hash
            def slow_hash(path):
                time.sleep(.05)
                return real_hash(path)
            with mock.patch.object(run_hil, "_safe_hash", side_effect=slow_hash):
                run_hil._finalize(Path(directory), manifest, time.monotonic())
            wall = manifest["budget_validity"]["wall_time_seconds"]
            self.assertGreaterEqual(wall["observed"], .05)
            self.assertFalse(wall["within_budget"])

    def test_candidate_symlink_escape_is_rejected_before_commands(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate"
            candidate.mkdir()
            (candidate / "escape").symlink_to(task / "hidden")
            marker = root / "ran"
            tool = executable_fixture(root, f"Path({str(marker)!r}).write_text('ran')\n")
            result = self._run_cli(
                task, "--run-dir", root / "run", "--evaluate-only", "--candidate", candidate,
                "--jtag-serial", "J", "--uart-device", "/dev/null", "--openocd", tool,
                "--platformio", tool,
            )
            self.assertEqual(result.returncode, 2)
            self.assertFalse(marker.exists())

    def test_agent_mode_repairs_workspace_with_allowlisted_home_and_no_secret_evidence(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            invocation = root / "agent-invocation.json"
            agent_dir = root / "agent"
            agent_dir.mkdir()
            agent = executable_fixture(agent_dir, textwrap.dedent(f"""
                import json, os, pathlib, sys
                if '--version' in sys.argv: print('agent fixture 1'); raise SystemExit(0)
                assert os.environ['HOME'] == 'HOME_SENTINEL'
                assert os.environ['LABWIRED_HOME'] == 'LABWIRED_HOME_SENTINEL'
                print(os.environ['LABWIRED_ACCESS_TOKEN'], os.environ['LABWIRED_MODEL_KEY'])
                assert 'hidden' not in ' '.join(sys.argv).lower()
                source = pathlib.Path('firmware/src/main.c')
                source.write_text(source.read_text().replace('GPIO_MODE_INPUT', 'GPIO_MODE_OUTPUT'))
                pathlib.Path({str(invocation)!r}).write_text(json.dumps({{'argv': sys.argv[1:], 'cwd': pathlib.Path.cwd().name}}))
            """))
            pio_dir = root / "pio"
            pio_dir.mkdir()
            pio = executable_fixture(pio_dir, "import os,sys\nprint(os.environ.get('LABWIRED_ACCESS_TOKEN','ABSENT'), os.environ.get('HOST_SECRET','ABSENT'))\nif '--version' in sys.argv: print('pio fixture 1'); raise SystemExit(0)\nraise SystemExit(0 if 'clean' in sys.argv else 1)\n")
            env = {**os.environ, "HOME": "HOME_SENTINEL", "LABWIRED_HOME": "LABWIRED_HOME_SENTINEL",
                   "LABWIRED_ACCESS_TOKEN": "SECRET_TOKEN_SENTINEL", "LABWIRED_MODEL_KEY": "MODEL_KEY_SENTINEL",
                   "HOST_SECRET": "HOST_SECRET_SENTINEL"}
            usage = root / "usage.json"
            usage.write_text(json.dumps({"schema_version": "1.0", "requests": 1,
                "tokens": {"fresh_input": 1000, "cached_input": 2000, "output": 3000, "reasoning": 4},
                "final_context_tokens": 55, "latency_seconds": .01, "provider": "fixture", "model": "fixture/model",
                "rates_usd_per_million": {"fresh_input": 1, "cached_input": 1, "output": 1},
                "price_source": "fixture", "price_effective_date": "2026-01-01"}))
            run_dir = root / "run"
            result = self._run_cli(task, "--run-dir", run_dir, "--agent-bin", agent, "--model", "fixture/model",
                                   "--jtag-serial", "J", "--uart-device", "/dev/null", "--openocd", pio,
                                   "--platformio", pio, "--usage-json", usage, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            call = json.loads(invocation.read_text())
            self.assertEqual(call["argv"][:4], ["agent", "run", "--model", "fixture/model"])
            self.assertTrue(call["cwd"].startswith("agent-workspace-"))
            manifest_text = (run_dir / "run.json").read_text()
            self.assertNotIn("SECRET_TOKEN_SENTINEL", manifest_text)
            for path in run_dir.rglob("*"):
                if path.is_file():
                    contents = path.read_bytes()
                    for sentinel in (b"SECRET_TOKEN_SENTINEL", b"MODEL_KEY_SENTINEL", b"HOST_SECRET_SENTINEL"):
                        self.assertNotIn(sentinel, contents)
            manifest = json.loads(manifest_text)
            self.assertEqual(manifest["model_status"], "pass")
            self.assertEqual(manifest["budget_validity"]["model_tokens"]["observed"], 55)
            self.assertNotEqual(manifest["hashes"]["source_initial"], manifest["hashes"]["source_final"])

    def test_agent_symlink_and_fifo_are_rejected_without_reading_external_secret(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); secret = root / "secret"; secret.write_text("EXTERNAL_SECRET_SENTINEL")
            agent_dir = root / "agent"; agent_dir.mkdir()
            agent = executable_fixture(agent_dir, textwrap.dedent(f"""
                import os, pathlib, sys
                if '--version' in sys.argv: print('v'); raise SystemExit(0)
                pathlib.Path('escape').symlink_to({str(secret)!r})
                os.mkfifo('special.fifo')
            """))
            tool_dir = root / "tool"; tool_dir.mkdir()
            tool = executable_fixture(tool_dir, "print('v')\n")
            run_dir = root / "run"
            result = self._run_cli(task, "--run-dir", run_dir, "--agent-bin", agent, "--model", "fixture",
                "--jtag-serial", "J", "--uart-device", "/dev/null", "--openocd", tool, "--platformio", tool)
            self.assertEqual(result.returncode, 2)
            manifest_text = (run_dir / "run.json").read_text()
            self.assertNotIn("EXTERNAL_SECRET_SENTINEL", manifest_text)
            self.assertNotIn("escape", json.loads(manifest_text).get("artifacts", []))
            for path in run_dir.rglob("*"):
                info = path.lstat()
                self.assertFalse(stat.S_ISLNK(info.st_mode) or stat.S_ISFIFO(info.st_mode))
                if stat.S_ISREG(info.st_mode): self.assertNotIn(b"EXTERNAL_SECRET_SENTINEL", path.read_bytes())

    def test_agent_credential_written_to_workspace_is_rejected_before_hash_or_build(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); agent_dir = root / "agent"; agent_dir.mkdir()
            agent = executable_fixture(agent_dir, """import os,pathlib,sys
if '--version' in sys.argv: print('v'); raise SystemExit(0)
pathlib.Path('credential.txt').write_text(os.environ['LABWIRED_ACCESS_TOKEN'])
""")
            tool_dir = root / "tool"; tool_dir.mkdir(); marker = root / "tool-ran"
            tool = executable_fixture(tool_dir, f"import sys\nif '--version' in sys.argv: print('v'); raise SystemExit(0)\nfrom pathlib import Path; Path({str(marker)!r}).write_text('ran')\n")
            run_dir = root / "run"; env = {**os.environ, "LABWIRED_ACCESS_TOKEN": "WORKSPACE_TOKEN_SENTINEL"}
            result = self._run_cli(task, "--run-dir", run_dir, "--agent-bin", agent, "--model", "fixture",
                "--jtag-serial", "J", "--uart-device", "/dev/null", "--openocd", tool, "--platformio", tool, env=env)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(marker.exists())
            manifest_text = (run_dir / "run.json").read_text()
            self.assertNotIn("WORKSPACE_TOKEN_SENTINEL", manifest_text)
            self.assertNotIn("credential.txt", json.loads(manifest_text).get("artifacts", []))
            self.assertFalse((run_dir / "workspace").exists())

    def test_agent_oversize_sparse_file_is_bounded_and_workspace_quarantined(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); agent_dir = root / "agent"; agent_dir.mkdir()
            agent = executable_fixture(agent_dir, """import pathlib,sys
if '--version' in sys.argv: print('v'); raise SystemExit(0)
with pathlib.Path('huge.bin').open('wb') as out: out.truncate(40 * 1024 * 1024)
""")
            tool_dir=root/'tool'; tool_dir.mkdir(); tool=executable_fixture(tool_dir,"print('v')\n")
            run_dir=root/'run'; started=time.monotonic()
            result=self._run_cli(task,'--run-dir',run_dir,'--agent-bin',agent,'--model','m','--jtag-serial','J',
                '--uart-device','/dev/null','--openocd',tool,'--platformio',tool)
            self.assertEqual(result.returncode,2); self.assertLess(time.monotonic()-started,3)
            self.assertFalse((run_dir/'workspace').exists())
            self.assertEqual(json.loads((run_dir/'run.json').read_text())["failure_category"],"unsafe_workspace")

    def test_fd_relative_quarantine_delete_never_follows_swapped_symlink(self):
        sys.path.insert(0,str(REPOSITORY_ROOT/'benchmarks/twin2silicon')); import run_hil
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); victim=root/'victim'; child=victim/'child'; child.mkdir(parents=True)
            for index in range(500): (child/f'f{index}').write_text('x')
            external=root/'external'; external.mkdir(); sentinel=external/'sentinel'; sentinel.write_text('safe')
            moved=victim/'moved'; stop=threading.Event()
            def swap():
                while not stop.is_set():
                    try:
                        child.rename(moved); child.symlink_to(external, target_is_directory=True)
                        child.unlink(); moved.rename(child)
                    except (FileNotFoundError,OSError): pass
            thread=threading.Thread(target=swap); thread.start()
            try:
                try: run_hil._safe_remove_tree(victim)
                except run_hil.UnsafeWorkspaceError: pass
            finally:
                stop.set(); thread.join(1)
            self.assertEqual(sentinel.read_text(),'safe')

    def test_detached_agent_mutator_cannot_change_frozen_workspace(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); pid_path=root/'child.pid'; agent_dir=root/'agent'; agent_dir.mkdir()
            child = "import os,pathlib,time; f=open('firmware/src/main.c','ab',buffering=0); pathlib.Path(%r).write_text(str(os.getpid()));\nwhile True: f.write(b'X'); time.sleep(.01)" % str(pid_path)
            agent=executable_fixture(agent_dir, textwrap.dedent(f"""
                import subprocess,sys,time
                if '--version' in sys.argv: print('v'); raise SystemExit(0)
                subprocess.Popen([sys.executable,'-c',{child!r}], start_new_session=True)
                import pathlib
                while not pathlib.Path({str(pid_path)!r}).exists(): time.sleep(.01)
            """))
            build_pid=root/'build-child.pid'; tool_dir=root/'tool'; tool_dir.mkdir()
            tool=executable_fixture(tool_dir,textwrap.dedent(f"""
                import pathlib,subprocess,sys
                if '--version' in sys.argv: print('v'); raise SystemExit(0)
                if 'clean' in sys.argv: raise SystemExit(0)
                project=pathlib.Path(sys.argv[sys.argv.index('--project-dir')+1])
                child="import os,pathlib,time; p=pathlib.Path(%r); pathlib.Path(%r).write_text(str(os.getpid()));\\nwhile True:\\n p.parent.mkdir(parents=True,exist_ok=True); open(p,'ab').write(b'Y'); time.sleep(.01)" % (str(project/'src/main.c'), {str(build_pid)!r})
                subprocess.Popen([sys.executable,'-c',child],start_new_session=True)
                raise SystemExit(1)
            """))
            run_dir=root/'run'
            try:
                result=self._run_cli(task,'--run-dir',run_dir,'--agent-bin',agent,'--model','m','--jtag-serial','J',
                    '--uart-device','/dev/null','--openocd',tool,'--platformio',tool)
                self.assertEqual(result.returncode,0,result.stderr)
                sys.path.insert(0,str(REPOSITORY_ROOT/'benchmarks/twin2silicon')); import run_hil
                before=run_hil._tree_hash(run_dir/'source'); time.sleep(.2)
                self.assertEqual(before,run_hil._tree_hash(run_dir/'source'))
                self.assertEqual(before,json.loads((run_dir/'run.json').read_text())["hashes"]["source_final"])
            finally:
                if pid_path.exists():
                    try: os.kill(int(pid_path.read_text()),signal.SIGKILL)
                    except ProcessLookupError: pass
                if build_pid.exists():
                    try: os.kill(int(build_pid.read_text()),signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_cli_physical_pass_uses_pty_and_records_ordered_evidence(self):
        task = self._short_task()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            order = root / "order.log"
            marker = root / "flash"
            pio_dir = root / "pio"; pio_dir.mkdir()
            pio = executable_fixture(pio_dir, textwrap.dedent(f"""
                import pathlib, sys, time
                if '--version' in sys.argv: print('pio fixture 1'); raise SystemExit(0)
                order = pathlib.Path({str(order)!r})
                target = sys.argv[sys.argv.index('--target') + 1] if '--target' in sys.argv else 'build'
                with order.open('a') as out: out.write(target + '\\n')
                project = pathlib.Path(sys.argv[sys.argv.index('--project-dir') + 1])
                if target == 'build':
                    artifact = project / '.pio/build/esp32s3/firmware.bin'; artifact.parent.mkdir(parents=True); artifact.write_bytes(b'fw')
                if target == 'upload': pathlib.Path({str(marker)!r}).write_text('flash'); time.sleep(.1)
            """))
            identity_dir = root / "identity"; identity_dir.mkdir()
            identity = executable_fixture(identity_dir, f"from pathlib import Path\nwith Path({str(order)!r}).open('a') as out: out.write('identity\\n')\nprint('JTAG-1')\n")
            openocd_dir = root / "openocd"; openocd_dir.mkdir()
            openocd = executable_fixture(openocd_dir, textwrap.dedent(f"""
                import pathlib, sys
                if '--version' in sys.argv: print('openocd fixture 1'); raise SystemExit(0)
                with pathlib.Path({str(order)!r}).open('a') as out: out.write('openocd\\n')
                print('@@REG gpio2_output_enabled 0x60004020', file=sys.stderr)
                print('0x60004020: 00000004', file=sys.stderr)
                print('@@REG gpio2_output_high 0x60004004', file=sys.stderr)
                print('0x60004004: 00000004', file=sys.stderr)
            """))
            master, slave = pty.openpty(); tty.setraw(slave)
            run_dir = root / "run"
            def writer():
                deadline = time.monotonic() + 2
                while not marker.exists() and time.monotonic() < deadline: time.sleep(.005)
                nonce = (run_dir / "workspace/firmware/include/run_nonce.h").read_text().split('"')[1]
                os.write(master, f"LABWIRED_READY:{nonce}\n".encode())
            thread = threading.Thread(target=writer); thread.start()
            try:
                result = self._run_cli(task, "--run-dir", run_dir, "--evaluate-only", "--candidate", task / "public",
                                       "--jtag-serial", "JTAG-1", "--uart-device", os.ttyname(slave),
                                       "--openocd", openocd, "--platformio", pio,
                                       "--identity-command-json", json.dumps([str(identity)]))
            finally:
                thread.join(2); os.close(master); os.close(slave)
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((run_dir / "run.json").read_text())
            self.assertEqual(manifest["hardware_status"], "pass")
            self.assertEqual(order.read_text().splitlines(), ["clean", "build", "identity", "upload", "openocd"])
            self.assertNotIn("JTAG-1", json.dumps(manifest))
            self.assertEqual(set(manifest["budget_validity"]),
                             {"wall_time_seconds", "model_tokens", "repair_iterations", "simulator_runs", "diagnostic_hil_runs"})
            self.assertEqual(manifest["budget_validity"]["simulator_runs"]["observed"], 0)
            self.assertEqual(manifest["budget_validity"]["diagnostic_hil_runs"]["observed"], 0)
            self.assertEqual([phase["name"] for phase in manifest["phases"]],
                             ["prepared", "clean", "build", "identity", "flash", "uart", "register"])
            self.assertEqual(set(manifest["tool_versions"]), {"platformio", "openocd"})
            self.assertTrue(all("executable" in item and "version" in item
                                for item in manifest["tool_versions"].values()))
            for artifact in manifest["artifacts"]:
                path = run_dir / artifact
                self.assertTrue(path.is_file())
                self.assertEqual(manifest["hashes"][f"artifact:{artifact}"], sha256_file(path))

    def test_clean_nonzero_is_infrastructure_and_never_touches_identity(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); marker = root / "identity-ran"
            pio_dir = root / "pio"; pio_dir.mkdir()
            pio = executable_fixture(pio_dir, "import sys\nif '--version' in sys.argv: print('v'); raise SystemExit(0)\nraise SystemExit(7)\n")
            identity_dir = root / "identity"; identity_dir.mkdir()
            identity = executable_fixture(identity_dir, f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')\n")
            openocd_dir = root / "openocd"; openocd_dir.mkdir()
            openocd = executable_fixture(openocd_dir, "print('v')\n")
            run_dir = root / "run"
            result = self._run_cli(task, "--run-dir", run_dir, "--evaluate-only", "--candidate", task / "public",
                                   "--jtag-serial", "J", "--uart-device", "/dev/null", "--openocd", openocd,
                                   "--platformio", pio, "--identity-command-json", json.dumps([str(identity)]))
            self.assertEqual(result.returncode, 2)
            self.assertFalse(marker.exists())
            manifest = json.loads((run_dir / "run.json").read_text())
            self.assertEqual((manifest["compile_status"], manifest["infrastructure_status"]), ("not_run", "error"))
            self.assertEqual([phase["name"] for phase in manifest["phases"]], ["prepared", "clean"])

    def test_identity_launch_detail_redacts_serial_device_and_credentials(self):
        task=REPOSITORY_ROOT/'benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001'
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); tool_dir=root/'tool'; tool_dir.mkdir()
            tool=executable_fixture(tool_dir,"""import pathlib,sys
if '--version' in sys.argv: print('v'); raise SystemExit(0)
if '--target' not in sys.argv:
 p=pathlib.Path(sys.argv[sys.argv.index('--project-dir')+1])/'.pio/build/esp32s3/firmware.bin'; p.parent.mkdir(parents=True); p.write_bytes(b'fw')
""")
            serial='RAW_SERIAL_SENTINEL'; device='/dev/RAW_DEVICE_SENTINEL'; credential='RAW_CREDENTIAL_SENTINEL'
            env={**os.environ,'LABWIRED_ACCESS_TOKEN':credential}; run_dir=root/'run'
            result=self._run_cli(task,'--run-dir',run_dir,'--evaluate-only','--candidate',task/'public',
                '--jtag-serial',serial,'--uart-device',device,'--openocd',tool,'--platformio',tool,
                '--identity-command-json',json.dumps([f'/missing/{serial}/{credential}']),env=env)
            self.assertEqual(result.returncode,2)
            combined=(run_dir/'run.json').read_text()+result.stderr
            for value in (serial,device,credential): self.assertNotIn(value,combined)

    def test_overall_wall_deadline_bounds_cumulative_phases(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); marker = root / "identity"
            pio_dir = root / "pio"; pio_dir.mkdir()
            pio = executable_fixture(pio_dir, """import pathlib,sys,time
if '--version' in sys.argv: print('v'); raise SystemExit(0)
time.sleep(.18)
if '--target' not in sys.argv:
 p=pathlib.Path(sys.argv[sys.argv.index('--project-dir')+1])/'.pio/build/esp32s3/firmware.bin'; p.parent.mkdir(parents=True); p.write_bytes(b'fw')
""")
            identity_dir = root / "id"; identity_dir.mkdir()
            identity = executable_fixture(identity_dir, f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')\n")
            run_dir = root / "run"
            result = self._run_cli(task, "--run-dir", run_dir, "--evaluate-only", "--candidate", task / "public",
                "--jtag-serial", "J", "--uart-device", "/dev/null", "--openocd", pio, "--platformio", pio,
                "--identity-command-json", json.dumps([str(identity)]), "--fixture-wall-time-seconds", ".45")
            self.assertEqual(result.returncode, 2)
            self.assertFalse(marker.exists())
            manifest = json.loads((run_dir / "run.json").read_text())
            self.assertFalse(manifest["budget_validity"]["wall_time_seconds"]["within_budget"])

    def test_uart_startup_hang_is_killed_before_bounded_finalization(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); pio_dir = root / "pio"; pio_dir.mkdir()
            pio = executable_fixture(pio_dir, """import pathlib,sys
if '--version' in sys.argv: print('v'); raise SystemExit(0)
if '--target' not in sys.argv:
 p=pathlib.Path(sys.argv[sys.argv.index('--project-dir')+1])/'.pio/build/esp32s3/firmware.bin'; p.parent.mkdir(parents=True); p.write_bytes(b'fw')
""")
            identity_dir = root / "id"; identity_dir.mkdir()
            identity = executable_fixture(identity_dir, "print('JTAG-HANG')\n")
            run_dir = root / "run"; started = time.monotonic()
            result = self._run_cli(task, "--run-dir", run_dir, "--evaluate-only", "--candidate", task / "public",
                "--jtag-serial", "JTAG-HANG", "--uart-device", "/dev/null", "--openocd", pio,
                "--platformio", pio, "--identity-command-json", json.dumps([str(identity)]),
                "--fixture-uart-worker-mode", "startup-hang", "--fixture-identity-timeout-seconds", ".3")
            self.assertEqual(result.returncode, 2)
            self.assertLess(time.monotonic() - started, 4)
            manifest_path = run_dir / "run.json"; manifest = json.loads(manifest_path.read_text())
            self.assertEqual(manifest["infrastructure_status"], "error")
            before = {path: path.stat().st_mtime_ns for path in run_dir.rglob("*") if path.is_file()}
            time.sleep(.2)
            self.assertEqual(before, {path: path.stat().st_mtime_ns for path in run_dir.rglob("*") if path.is_file()})
            with BoardLock(run_dir.parent / ".board-locks", "JTAG-HANG", timeout_seconds=.1): pass

    def test_cli_sigint_cleans_uart_flash_descendants_and_finalizes_stable_evidence(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); marker = root / "flash-pids.json"
            pio_dir = root / "pio"; pio_dir.mkdir()
            pio = executable_fixture(pio_dir, textwrap.dedent(f"""
                import json, os, pathlib, signal, subprocess, sys, time
                if '--version' in sys.argv: print('v'); raise SystemExit(0)
                project = pathlib.Path(sys.argv[sys.argv.index('--project-dir') + 1])
                target = sys.argv[sys.argv.index('--target') + 1] if '--target' in sys.argv else 'build'
                if target == 'build':
                    p=project/'.pio/build/esp32s3/firmware.bin'; p.parent.mkdir(parents=True); p.write_bytes(b'fw')
                if target == 'upload':
                    child=subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'])
                    pathlib.Path({str(marker)!r}).write_text(json.dumps({{'leader': os.getpid(), 'child': child.pid}}))
                    time.sleep(30)
            """))
            identity_dir = root / "id"; identity_dir.mkdir()
            identity = executable_fixture(identity_dir, "print('JTAG-INT')\n")
            master, slave = pty.openpty(); tty.setraw(slave); run_dir = root / "run"
            command = [sys.executable, str(REPOSITORY_ROOT / "benchmarks/twin2silicon/run_hil.py"), str(task),
                "--run-dir", str(run_dir), "--evaluate-only", "--candidate", str(task / "public"),
                "--jtag-serial", "JTAG-INT", "--uart-device", os.ttyname(slave), "--openocd", str(pio),
                "--platformio", str(pio), "--identity-command-json", json.dumps([str(identity)])]
            process = subprocess.Popen(command, cwd=REPOSITORY_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            deadline = time.monotonic() + 8
            while not marker.exists() and time.monotonic() < deadline: time.sleep(.01)
            self.assertTrue(marker.exists(), "flash did not become active")
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate(timeout=6)
            os.close(master); os.close(slave)
            self.assertEqual(process.returncode, 2, stderr.decode())
            manifest = json.loads((run_dir / "run.json").read_text())
            self.assertEqual(manifest["termination"], "interrupted")
            for pid in json.loads(marker.read_text()).values():
                with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
            with BoardLock(run_dir.parent / ".board-locks", "JTAG-INT", timeout_seconds=.1): pass
            before = {p: (p.stat().st_mtime_ns, sha256_file(p)) for p in run_dir.rglob('*') if p.is_file()}
            time.sleep(.2)
            self.assertEqual(before, {p: (p.stat().st_mtime_ns, sha256_file(p)) for p in run_dir.rglob('*') if p.is_file()})
            for artifact in manifest["artifacts"]:
                self.assertEqual(manifest["hashes"][f"artifact:{artifact}"], sha256_file(run_dir / artifact))

    def test_cli_classifies_candidate_and_infrastructure_physical_failures(self):
        task = self._short_task()
        cases = (
            ("flash", 9, True, 4, 0, "fail", "ok"),
            ("nonce", 0, False, 4, 0, "fail", "ok"),
            ("register", 0, True, 0, 0, "fail", "ok"),
            ("identity", 0, True, 4, 0, "not_run", "error"),
            ("lock", 0, True, 4, 0, "not_run", "error"),
            ("openocd", 0, True, 4, 7, "not_run", "error"),
        )
        for name, flash_code, send_nonce, register_value, openocd_code, hardware, infrastructure in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); marker = root / "flash"
                pio_dir = root / "pio"; pio_dir.mkdir()
                pio = executable_fixture(pio_dir, textwrap.dedent(f"""
                    import pathlib, sys, time
                    if '--version' in sys.argv: print('v'); raise SystemExit(0)
                    target = sys.argv[sys.argv.index('--target') + 1] if '--target' in sys.argv else 'build'
                    project = pathlib.Path(sys.argv[sys.argv.index('--project-dir') + 1])
                    if target == 'build':
                        artifact = project / '.pio/build/esp32s3/firmware.bin'; artifact.parent.mkdir(parents=True); artifact.write_bytes(b'fw')
                    if target == 'upload': pathlib.Path({str(marker)!r}).write_text('x'); time.sleep(.05); raise SystemExit({flash_code})
                """))
                identity_dir = root / "identity"; identity_dir.mkdir()
                identity = executable_fixture(identity_dir, f"print({('OTHER' if name == 'identity' else 'JTAG-1')!r})\n")
                openocd_dir = root / "openocd"; openocd_dir.mkdir()
                openocd = executable_fixture(openocd_dir, textwrap.dedent(f"""
                    import sys
                    if '--version' in sys.argv: print('v'); raise SystemExit(0)
                    if {openocd_code}: raise SystemExit({openocd_code})
                    print('@@REG gpio2_output_enabled 0x60004020', file=sys.stderr); print('0x60004020: {register_value:08x}', file=sys.stderr)
                    print('@@REG gpio2_output_high 0x60004004', file=sys.stderr); print('0x60004004: {register_value:08x}', file=sys.stderr)
                """))
                master, slave = pty.openpty(); tty.setraw(slave); run_dir = root / "run"
                def writer():
                    deadline = time.monotonic() + 2
                    while not marker.exists() and time.monotonic() < deadline: time.sleep(.005)
                    if send_nonce and marker.exists():
                        nonce = (run_dir / "workspace/firmware/include/run_nonce.h").read_text().split('"')[1]
                        os.write(master, f"LABWIRED_READY:{nonce}\n".encode())
                thread = threading.Thread(target=writer); thread.start()
                try:
                    lock = (BoardLock(run_dir.parent / ".board-locks", "JTAG-1", timeout_seconds=.1)
                            if name == "lock" else contextlib.nullcontext())
                    with lock:
                        cli = [task, "--run-dir", run_dir, "--evaluate-only", "--candidate", task / "public",
                               "--jtag-serial", "JTAG-1", "--uart-device", os.ttyname(slave),
                               "--openocd", openocd, "--platformio", pio,
                               "--fixture-uart-timeout-seconds", ".3",
                               "--identity-command-json", json.dumps([str(identity)])]
                        if name == "lock":
                            cli += ["--fixture-identity-timeout-seconds", ".3"]
                        result = self._run_cli(*cli)
                finally:
                    thread.join(2); os.close(master); os.close(slave)
                manifest = json.loads((run_dir / "run.json").read_text())
                self.assertEqual(result.returncode, 2 if infrastructure == "error" else 0, result.stderr)
                self.assertEqual((manifest["hardware_status"], manifest["infrastructure_status"]),
                                 (hardware, infrastructure))
                with BoardLock(run_dir.parent / ".board-locks", "JTAG-1", timeout_seconds=.1):
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
