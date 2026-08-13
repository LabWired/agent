#!/usr/bin/env python3
"""Run one command with a bounded wall-clock duration."""

import argparse
import math
import os
import signal
import subprocess
import sys
import time


TERMINATION_GRACE_SECONDS = 1


def positive_seconds(value):
    try:
        seconds = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("timeout must be a positive number of seconds") from error
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("timeout must be a finite positive number of seconds")
    return seconds


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Run a command with a time limit.",
        usage="%(prog)s --timeout SECONDS [--timeout-marker PATH] -- COMMAND [ARG ...]",
    )
    parser.add_argument("--timeout", required=True, type=positive_seconds, metavar="SECONDS")
    parser.add_argument("--timeout-marker", metavar="PATH")
    if "--" not in argv:
        parser.error("command must follow '--'")

    separator = argv.index("--")
    options = parser.parse_args(argv[:separator])
    command = argv[separator + 1 :]
    if not command:
        parser.error("command must not be empty")
    return options.timeout, options.timeout_marker, command


def send_signal(process, signum):
    if os.name == "posix":
        try:
            os.killpg(process.pid, signum)
        except (PermissionError, ProcessLookupError):
            pass
    else:
        try:
            process.terminate()
        except ProcessLookupError:
            pass


def stop_process(process, initial_signal=signal.SIGTERM):
    send_signal(process, initial_signal)
    if os.name == "posix":
        time.sleep(TERMINATION_GRACE_SECONDS)
        send_signal(process, signal.SIGKILL)
    else:
        try:
            process.wait(timeout=TERMINATION_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except ProcessLookupError:
                pass
    process.wait()


def shell_exit_code(returncode):
    if returncode < 0:
        return 128 + abs(returncode)
    return returncode


def main(argv):
    timeout, timeout_marker, command = parse_args(argv)
    if timeout_marker is not None:
        try:
            os.unlink(timeout_marker)
        except FileNotFoundError:
            pass
        except OSError as error:
            print(f"run-bounded: cannot clear timeout marker: {error}", file=sys.stderr)
            return 2
    popen_args = {}
    if os.name == "posix":
        popen_args["start_new_session"] = True
    process_holder = [None]
    stopping = False

    def forward_signal(signum, _frame):
        nonlocal stopping
        if stopping:
            return
        stopping = True
        if process_holder[0] is not None:
            stop_process(process_holder[0], signum)
        raise SystemExit(128 + signum)

    handled_signals = [signal.SIGINT, signal.SIGTERM]
    for signal_name in ("SIGHUP", "SIGQUIT"):
        signum = getattr(signal, signal_name, None)
        if signum is not None:
            handled_signals.append(signum)

    handlers = {}
    for signum in handled_signals:
        handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, forward_signal)

    try:
        process_holder[0] = subprocess.Popen(command, **popen_args)
        return shell_exit_code(process_holder[0].wait(timeout=timeout))
    except subprocess.TimeoutExpired:
        if timeout_marker is not None:
            try:
                with open(timeout_marker, "w", encoding="utf-8") as marker_file:
                    marker_file.write("timeout\n")
            except OSError as error:
                print(f"run-bounded: cannot write timeout marker: {error}", file=sys.stderr)
        stop_process(process_holder[0])
        print(
            f"run-bounded: command {command[0]!r} timed out after {timeout:g} seconds",
            file=sys.stderr,
        )
        return 124
    finally:
        for signum, handler in handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
