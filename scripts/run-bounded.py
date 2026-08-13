#!/usr/bin/env python3
"""Run one command with a bounded wall-clock duration."""

import argparse
import math
import os
import signal
import subprocess
import sys


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
        usage="%(prog)s --timeout SECONDS -- COMMAND [ARG ...]",
    )
    parser.add_argument("--timeout", required=True, type=positive_seconds, metavar="SECONDS")
    if "--" not in argv:
        parser.error("command must follow '--'")

    separator = argv.index("--")
    options = parser.parse_args(argv[:separator])
    command = argv[separator + 1 :]
    if not command:
        parser.error("command must not be empty")
    return options.timeout, command


def stop_process(process):
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    else:
        try:
            process.terminate()
        except ProcessLookupError:
            pass

    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        process.wait()


def main(argv):
    timeout, command = parse_args(argv)
    popen_args = {}
    if os.name == "posix":
        popen_args["start_new_session"] = True
    process = subprocess.Popen(command, **popen_args)
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        stop_process(process)
        print(
            f"run-bounded: command {command[0]!r} timed out after {timeout:g} seconds",
            file=sys.stderr,
        )
        return 124


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
