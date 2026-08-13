#!/usr/bin/env python3
"""Run rust-minidump under fixed resource and disclosure boundaries."""

from __future__ import annotations

import json
import os
from pathlib import Path, PureWindowsPath
import resource
import subprocess
import sys
import tempfile
from typing import Any

MAX_OUTPUT_BYTES = 4 * 1024 * 1024
PROCESS_TIMEOUT_SECONDS = 25
PATH_KEYS = {"debug_file", "filename", "file", "source_file", "path"}
DROP_KEYS = {
    "command_line",
    "environment",
    "memory",
    "stack_memory",
    "source_context",
}


def apply_limits() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (896 * 1024 * 1024, 896 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (PROCESS_TIMEOUT_SECONDS, PROCESS_TIMEOUT_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    # Do not set RLIMIT_NPROC here. Linux accounts it against the host UID, so
    # unrelated containers that map this non-root UID can exhaust the limit and
    # make a valid report fail nondeterministically. The wrapper launches one
    # fixed parser binary, which does not execute dump content or spawn child
    # processes; the container boundary and the limits above constrain it.


def safe_path(value: str) -> str:
    if len(value) > 2 and value[1:3] in {":\\", ":/"}:
        return PureWindowsPath(value).name
    if value.startswith("/"):
        return Path(value).name
    return value


def sanitize(value: Any, key: str | None = None) -> Any:
    if isinstance(value, dict):
        return {
            child_key: sanitize(child_value, child_key)
            for child_key, child_value in value.items()
            if child_key not in DROP_KEYS
        }
    if isinstance(value, list):
        return [sanitize(child, key) for child in value]
    if isinstance(value, str) and key in PATH_KEYS:
        return safe_path(value)
    return value


def emit(processor_status: str, **properties: Any) -> None:
    json.dump({"status": processor_status, **properties}, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


def main() -> int:
    if len(sys.argv) != 3:
        emit("malformed", reason="invalid_arguments")
        return 0

    dump_path, symbols_path = sys.argv[1:]
    environment = {
        "HOME": "/tmp/avalon-symbolicator",
        "LANG": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "RUST_BACKTRACE": "0",
    }
    try:
        with tempfile.TemporaryFile() as output:
            completed = subprocess.run(
                [
                    "/usr/local/bin/minidump-stackwalk",
                    "--json",
                    "--symbols-path",
                    symbols_path,
                    dump_path,
                ],
                check=False,
                cwd="/workspace",
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                timeout=PROCESS_TIMEOUT_SECONDS,
                preexec_fn=apply_limits,
            )
            if completed.returncode != 0:
                emit("malformed", reason="processor_failed")
                return 0
            size = output.tell()
            if size > MAX_OUTPUT_BYTES:
                emit("malformed", reason="report_too_large")
                return 0
            output.seek(0)
            report = json.load(output)
    except subprocess.TimeoutExpired:
        emit("unsymbolicated", reason="processor_timeout")
        return 0
    except (OSError, ValueError, json.JSONDecodeError):
        emit("malformed", reason="processor_output_invalid")
        return 0

    if not isinstance(report, dict):
        emit("malformed", reason="processor_output_invalid")
        return 0
    sanitized = sanitize(report)
    if not isinstance(sanitized, dict):
        emit("malformed", reason="processor_output_invalid")
        return 0
    sanitized.pop("status", None)
    emit("ok", **sanitized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
