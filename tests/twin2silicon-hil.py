#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import pty
import signal
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
from benchmarks.twin2silicon.runtime_adapters import (
    AdapterContext,
    NormalizedUsage,
    build_runtime_command,
    codex_mcp_toml,
    normalize_usage,
    write_codex_mcp_config,
)


def executable_fixture(directory, body):
    path = Path(directory) / "fixture.py"
    path.write_text("#!/usr/bin/env python3\n" + body, encoding="utf-8")
    path.chmod(0o755)
    return path


class RuntimeAdapterTests(unittest.TestCase):
    def adapter_context(self, runtime, executable=None):
        directory = Path("/tmp/runtime-adapter-test")
        return AdapterContext(
            runtime=runtime,
            executable=executable or runtime,
            workspace=directory / "workspace",
            prompt="Complete the public firmware task.",
            config_dir=directory / "config",
            stdout_path=directory / "stdout.log",
            stderr_path=directory / "stderr.log",
        )

    def test_build_runtime_commands_use_native_structured_modes(self):
        contexts = {
            "codex": self.adapter_context("codex"),
            "claude": self.adapter_context("claude"),
            "opencode": self.adapter_context("opencode"),
        }
        commands = {
            runtime: build_runtime_command(runtime, context)
            for runtime, context in contexts.items()
        }

        self.assertEqual(commands["codex"][:2], ["codex", "exec"])
        self.assertEqual(commands["claude"][:2], ["claude", "--print"])
        self.assertEqual(commands["opencode"][:2], ["opencode", "run"])
        self.assertEqual(
            commands["codex"],
            [
                "codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check",
                "-s", "workspace-write", "-C", str(contexts["codex"].workspace),
                contexts["codex"].prompt,
            ],
        )
        self.assertEqual(
            commands["claude"],
            [
                "claude", "--print", "--output-format", "stream-json",
                "--no-session-persistence", "--permission-mode", "acceptEdits",
                "--mcp-config", str(contexts["claude"].config_dir / "claude-mcp.json"),
                "--strict-mcp-config",
                contexts["claude"].prompt,
            ],
        )
        self.assertEqual(
            commands["opencode"],
            [
                "opencode", "run", "--format", "json", "--dir",
                str(contexts["opencode"].workspace), contexts["opencode"].prompt,
            ],
        )
        self.assertEqual(
            Path(commands["claude"][commands["claude"].index("--mcp-config") + 1]).parent,
            contexts["claude"].config_dir,
        )
        hidden_oracle = "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001/hidden/hil-oracle.json"
        for command in commands.values():
            with self.subTest(command=command[:2]):
                self.assertNotIn("--model", command)
                self.assertNotIn(hidden_oracle, " ".join(command))

    def test_build_runtime_command_rejects_context_runtime_mismatch(self):
        context = self.adapter_context("codex")

        with self.assertRaisesRegex(ValueError, "runtime does not match context"):
            build_runtime_command("claude", context)

    def test_adapter_dataclasses_are_frozen(self):
        context = self.adapter_context("codex")
        usage = NormalizedUsage(None, None, None, None, None, None, None)

        with self.assertRaises((AttributeError, TypeError)):
            context.prompt = "another prompt"
        with self.assertRaises((AttributeError, TypeError)):
            usage.output = 1

    def test_normalize_opencode_step_finish_events(self):
        lines = [
            json.dumps({
                "type": "step_finish",
                "part": {
                    "tokens": {"input": 800, "cache": {"read": 200}, "reasoning": 20, "output": 500},
                    "cost": 0.002476282,
                },
            }),
            json.dumps({
                "type": "step_finish",
                "part": {
                    "tokens": {"input": 600, "cache": {"read": 300}, "reasoning": 28, "output": 576},
                    "cost": 0.005,
                },
            }),
        ]

        usage = normalize_usage("opencode", lines)

        self.assertEqual(usage.requests, 2)
        self.assertEqual(usage.fresh_input, 1400)
        self.assertEqual(usage.cached_input, 500)
        self.assertEqual(usage.reasoning, 48)
        self.assertEqual(usage.output, 1076)
        self.assertAlmostEqual(usage.estimated_cost_usd, 0.007476282)
        self.assertIsNone(usage.unavailable_reason)

    def test_normalize_codex_uses_final_cumulative_usage(self):
        lines = [
            json.dumps({"type": "turn.completed", "usage": {
                "input_tokens": 1000, "cached_input_tokens": 200,
                "reasoning_tokens": 10, "output_tokens": 500,
            }}),
            json.dumps({"type": "turn.completed", "usage": {
                "input_tokens": 1400, "cached_input_tokens": 300,
                "reasoning_tokens": 48, "output_tokens": 1076,
            }}),
        ]

        usage = normalize_usage("codex", lines)

        self.assertEqual(usage.requests, 1)
        self.assertEqual(usage.fresh_input, 1400)
        self.assertEqual(usage.cached_input, 300)
        self.assertEqual(usage.reasoning, 48)
        self.assertEqual(usage.output, 1076)
        self.assertIsNone(usage.estimated_cost_usd)
        self.assertIsNone(usage.unavailable_reason)

    def test_normalize_codex_uses_the_final_terminal_event(self):
        lines = [
            json.dumps({"type": "turn.completed", "usage": {
                "input_tokens": 1400, "output_tokens": 1076,
            }}),
            json.dumps({"type": "turn.completed"}),
        ]

        usage = normalize_usage("codex", lines)

        self.assertEqual(
            usage,
            NormalizedUsage(None, None, None, None, None, None, "runtime did not expose usage"),
        )

    def test_normalize_codex_accepts_zero_token_usage(self):
        usage = normalize_usage(
            "codex",
            [json.dumps({
                "type": "turn.completed",
                "usage": {"input_tokens": 0, "output_tokens": 0},
            })],
        )

        self.assertEqual(usage.requests, 1)
        self.assertEqual(usage.fresh_input, 0)
        self.assertEqual(usage.output, 0)
        self.assertIsNone(usage.unavailable_reason)

    def test_normalize_claude_final_result_usage_and_cost(self):
        lines = [
            json.dumps({"type": "assistant", "message": {"content": []}}),
            json.dumps({
                "type": "result",
                "subtype": "success",
                "usage": {
                    "input_tokens": 1400,
                    "cache_read_input_tokens": 300,
                    "output_tokens": 1076,
                },
                "total_cost_usd": 0.007476282,
            }),
        ]

        usage = normalize_usage("claude", lines)

        self.assertEqual(usage.requests, 1)
        self.assertEqual(usage.fresh_input, 1400)
        self.assertEqual(usage.cached_input, 300)
        self.assertIsNone(usage.reasoning)
        self.assertEqual(usage.output, 1076)
        self.assertAlmostEqual(usage.estimated_cost_usd, 0.007476282)
        self.assertIsNone(usage.unavailable_reason)

    def test_normalize_claude_uses_the_final_result_event(self):
        lines = [
            json.dumps({
                "type": "result",
                "usage": {"input_tokens": 1400, "output_tokens": 1076},
                "total_cost_usd": 0.007476282,
            }),
            json.dumps({"type": "result", "subtype": "success", "result": "complete"}),
        ]

        usage = normalize_usage("claude", lines)

        self.assertEqual(
            usage,
            NormalizedUsage(None, None, None, None, None, None, "runtime did not expose usage"),
        )

    def test_normalize_claude_accepts_zero_token_usage(self):
        usage = normalize_usage(
            "claude",
            [json.dumps({
                "type": "result",
                "usage": {"input_tokens": 0, "output_tokens": 0},
                "total_cost_usd": 0.0,
            })],
        )

        self.assertEqual(usage.requests, 1)
        self.assertEqual(usage.fresh_input, 0)
        self.assertEqual(usage.output, 0)
        self.assertEqual(usage.estimated_cost_usd, 0.0)
        self.assertIsNone(usage.unavailable_reason)

    def test_normalize_usage_ignores_malformed_lines(self):
        usage = normalize_usage("opencode", ["not json", "{", "[]"])

        self.assertEqual(
            usage,
            NormalizedUsage(None, None, None, None, None, None, "runtime did not expose usage"),
        )

    def test_normalize_opencode_rejects_aggregate_overflow(self):
        lines = [
            json.dumps({
                "type": "step_finish",
                "part": {
                    "tokens": {"output": 1_000_000_000_000},
                    "cost": 1_000_000_000.0,
                },
            }),
            json.dumps({
                "type": "step_finish",
                "part": {"tokens": {"output": 1}, "cost": 0.01},
            }),
        ]

        usage = normalize_usage("opencode", lines)

        self.assertEqual(usage.requests, 2)
        self.assertIsNone(usage.output)
        self.assertIsNone(usage.estimated_cost_usd)
        self.assertEqual(usage.unavailable_reason, "runtime did not expose usage")

    def test_normalize_usage_marks_success_without_accounting_unavailable(self):
        usage = normalize_usage(
            "claude",
            [json.dumps({"type": "result", "subtype": "success", "result": "complete"})],
        )

        self.assertEqual(usage.estimated_cost_usd, None)
        self.assertEqual(usage.unavailable_reason, "runtime did not expose usage")


class RuntimeConfigurationTests(unittest.TestCase):
    def test_shared_instructions_bound_repairs_and_evidence_to_public_workspace(self):
        instructions_path = (
            REPOSITORY_ROOT
            / "benchmarks"
            / "twin2silicon"
            / "shared-agent-instructions.md"
        )
        instructions = instructions_path.read_text(encoding="utf-8")

        self.assertLess(len(instructions.split()), 700)
        for required_text in (
            "smallest firmware repair",
            "public workspace",
            "hidden oracle",
            "self-grade",
            "compile evidence",
            "repair_iterations",
            "optional context and compile aids",
            "not the final oracle",
        ):
            with self.subTest(required_text=required_text):
                self.assertIn(required_text, instructions)

    def test_runtime_mcp_configs_use_only_the_local_labwired_server(self):
        config_root = REPOSITORY_ROOT / "benchmarks" / "twin2silicon" / "runtime-config"
        opencode = json.loads((config_root / "opencode.json").read_text(encoding="utf-8"))
        claude = json.loads((config_root / "claude-mcp.json").read_text(encoding="utf-8"))

        self.assertNotIn("model", opencode)
        self.assertNotIn("provider", opencode)
        self.assertEqual(set(opencode["mcp"]), {"labwired"})
        self.assertEqual(set(claude["mcpServers"]), {"labwired"})
        self.assertEqual(opencode["mcp"]["labwired"]["type"], "local")
        self.assertEqual(
            opencode["mcp"]["labwired"]["command"],
            ["npx", "-y", "@labwired/mcp"],
        )
        self.assertTrue(opencode["mcp"]["labwired"]["enabled"])
        installed_profile = json.loads(
            (REPOSITORY_ROOT / "config" / "opencode.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            opencode["permission"]["skill"],
            installed_profile["permission"]["skill"],
        )
        self.assertEqual(claude["mcpServers"]["labwired"], {
            "command": "npx",
            "args": ["-y", "@labwired/mcp"],
        })

    def test_codex_mcp_toml_uses_the_local_labwired_server(self):
        self.assertEqual(
            codex_mcp_toml(),
            '[mcp_servers.labwired]\ncommand = "npx"\nargs = ["-y", "@labwired/mcp"]\n',
        )

    def test_write_codex_mcp_config_creates_an_isolated_config_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config_dir = Path(directory) / "runtime-config"

            config_path = write_codex_mcp_config(config_dir)

            self.assertEqual(config_path, config_dir / "config.toml")
            self.assertEqual(config_path.read_text(encoding="utf-8"), codex_mcp_toml())


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
        self.assertLess(
            main_source.index("for (;;)"),
            main_source.index('printf("LABWIRED_READY:'),
        )
        sdkconfig_defaults = (
            task_root / "public" / "firmware" / "sdkconfig.defaults"
        ).read_text(encoding="utf-8")
        self.assertIn("# CONFIG_ESP_CONSOLE_NONE is not set", sdkconfig_defaults)
        self.assertNotIn("CONFIG_ESP_CONSOLE_UART_NONE", sdkconfig_defaults)
        platformio_ini = (
            task_root / "public" / "firmware" / "platformio.ini"
        ).read_text(encoding="utf-8")
        self.assertIn("board_upload.flash_size = 4MB", platformio_ini)


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
                         config.openocd_command_timeout_seconds), ("board/esp32s3-builtin.cfg", 20, 10))
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
            'echo "@@REG enable 0x60004020"; echo [capture "mdw 0x60004020 1"]; '
            'echo "@@REG high 0x60004004"; echo [capture "mdw 0x60004004 1"]; exit'])

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


class SimpleHilRunnerTests(unittest.TestCase):
    def _run_cli(self, *arguments):
        return subprocess.run(
            [sys.executable, str(REPOSITORY_ROOT / "benchmarks/twin2silicon/run_hil.py"),
             *map(str, arguments)],
            cwd=REPOSITORY_ROOT,
            text=True,
            capture_output=True,
            timeout=15,
        )

    def test_complete_fake_hil_pass(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate"
            import shutil
            shutil.copytree(task / "public", candidate)
            (candidate / "firmware/src/main.c").write_text(
                (candidate / "firmware/src/main.c").read_text().replace(
                    "GPIO_MODE_INPUT", "GPIO_MODE_OUTPUT"
                )
            )
            flash_marker = root / "flashed"
            run_dir = root / "run"
            pio_dir = root / "pio"
            pio_dir.mkdir()
            pio = executable_fixture(pio_dir, textwrap.dedent(f"""
                import pathlib, sys, time
                args = sys.argv[1:]
                project = pathlib.Path(args[args.index('--project-dir') + 1])
                if 'clean' in args:
                    raise SystemExit(0)
                if 'upload' in args:
                    uart_log = pathlib.Path({str(root / "run/uart.log")!r})
                    deadline = time.monotonic() + 1
                    while time.monotonic() < deadline and not uart_log.exists():
                        time.sleep(.01)
                    if uart_log.exists():
                        print('UART capture started before flash', file=sys.stderr)
                        raise SystemExit(2)
                    pathlib.Path({str(flash_marker)!r}).write_text('flashed')
                    raise SystemExit(0)
                artifact = project / '.pio/build/esp32s3/firmware.bin'
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_bytes(b'firmware')
            """))
            identity_dir = root / "identity"
            identity_dir.mkdir()
            identity = executable_fixture(identity_dir, "print('JTAG-1')\n")
            openocd_dir = root / "openocd"
            openocd_dir.mkdir()
            openocd = executable_fixture(openocd_dir, textwrap.dedent("""
                import sys
                print('@@REG gpio2_output_enabled 0x60004020', file=sys.stderr)
                print('0x60004020: 00000004', file=sys.stderr)
                print('@@REG gpio2_output_high 0x60004004', file=sys.stderr)
                print('0x60004004: 00000004', file=sys.stderr)
            """))
            master, slave = pty.openpty()
            uart = os.ttyname(slave)
            def write_uart():
                deadline = time.monotonic() + 10
                header = run_dir / "workspace/firmware/include/run_nonce.h"
                while time.monotonic() < deadline and not (flash_marker.exists() and header.exists()):
                    time.sleep(.01)
                if flash_marker.exists() and header.exists():
                    nonce = header.read_text().split('"')[1]
                    os.write(master, f"LABWIRED_READY:{nonce}\n".encode())
            writer = threading.Thread(target=write_uart)
            writer.start()
            result = self._run_cli(
                task, "--run-dir", run_dir, "--candidate", candidate,
                "--jtag-serial", "JTAG-1", "--uart-device", uart,
                "--platformio", pio, "--openocd", openocd,
                "--identity-command-json", json.dumps([str(identity)]),
            )
            writer.join(10)
            os.close(master)
            os.close(slave)
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((run_dir / "run.json").read_text())
            self.assertEqual(manifest["status"], "pass")
            self.assertEqual(manifest["compile_status"], "pass")
            self.assertEqual(manifest["hardware_status"], "pass")
            self.assertTrue(manifest["uart"]["matched"])
            self.assertTrue(all(item["passed"] for item in manifest["registers"]))

    def test_compile_failure_never_touches_hardware(self):
        task = REPOSITORY_ROOT / "benchmarks/twin2silicon/tasks/esp32s3-gpio-hil-001"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate"
            import shutil
            shutil.copytree(task / "public", candidate)
            marker = root / "hardware-ran"
            pio_dir = root / "pio"
            pio_dir.mkdir()
            pio = executable_fixture(pio_dir, "import sys; raise SystemExit(0 if 'clean' in sys.argv else 1)\n")
            hardware_dir = root / "hardware"
            hardware_dir.mkdir()
            hardware = executable_fixture(
                hardware_dir,
                f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n",
            )
            result = self._run_cli(
                task, "--run-dir", root / "run", "--candidate", candidate,
                "--jtag-serial", "JTAG-1", "--uart-device", "/dev/null",
                "--platformio", pio, "--openocd", hardware,
                "--identity-command-json", json.dumps([str(hardware)]),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((root / "run/run.json").read_text())
            self.assertEqual(manifest["status"], "fail")
            self.assertEqual(manifest["compile_status"], "fail")
            self.assertEqual(manifest["hardware_status"], "not_run")
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    if "-k" in sys.argv:
        pattern_index = sys.argv.index("-k") + 1
        if pattern_index < len(sys.argv) and " or " in sys.argv[pattern_index]:
            patterns = sys.argv.pop(pattern_index).split(" or ")
            sys.argv.pop(pattern_index - 1)
            for pattern in patterns:
                sys.argv.extend(("-k", pattern))
    unittest.main()
