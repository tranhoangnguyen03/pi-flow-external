#!/usr/bin/env python3
"""Drive the installed PiG terminal UI through a real Unix pseudo-terminal.

This exercises keyboard/input/modal behavior, not just registered commands.
It does not claim a human review, live model call, or account check.
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

if len(sys.argv) != 3:
    sys.exit("usage: pig-tui.py <built PiG bundle> <report.json>")
bundle = Path(sys.argv[1]).resolve()
report_file = Path(sys.argv[2]).resolve()
release = json.loads((bundle / "release.json").read_text())
root = Path(tempfile.mkdtemp(prefix="pig-flow-tui-"))
home = root / "installed shell home"
work = root / "worksite"
work.mkdir()
env = dict(os.environ)
env.update({
    "PIG_AGENT_HOME": str(home),
    "PI_COMMS_BROKER_DIR": str(root / "broker"),
    "PIG_OFFLINE": "1",
    "PI_OFFLINE": "1",
    "TERM": "xterm-256color",
    "COLUMNS": "140",
    "LINES": "48",
})
shell = bundle / release["id"]
report = {
    "scope": "Actual PiG terminal, real Flow modal via pseudo-terminal; no human/model/CLI-account access.",
    "buildId": release["buildId"],
    "flowCommit": next(x["sourceCommit"] for x in release["extensions"] if x["id"] == "external"),
    "checks": [],
}
CSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
OSC = re.compile(rb"\x1b\].*?(?:\x07|\x1b\\)", re.S)


def readable(raw):
    return CSI.sub(b"", OSC.sub(b"", raw)).decode("utf-8", errors="replace")


def run_case(name, command, expected, navigation=None):
    pid, fd = pty.fork()
    if pid == 0:
        args = [
            str(home / "bin" / release["id"]),
            "new", "--home", str(home), "--cwd", str(work),
            "--provider", "study", "--model", "probe", "--thinking", "off",
        ]
        os.execve(args[0], args, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 140, 0, 0))
    output = bytearray()
    started = time.monotonic()
    try:
        # Wait for the actual terminal screen rather than treating a command
        # registration or an RPC notification as a UI modal.
        startup = started + 12
        while time.monotonic() < startup and len(output) < 200:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(fd, 16384)
                except OSError:
                    chunk = b""
                if not chunk:
                    raise AssertionError("PiG TUI exited before accepting keyboard input")
                output.extend(chunk)
        if not output:
            raise AssertionError("PiG produced no terminal screen")
        time.sleep(1)
        os.write(fd, command.encode("utf-8") + b"\r")
        deadline = time.monotonic() + 18
        next_keys = None
        matched = False
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.15)
            if ready:
                try:
                    chunk = os.read(fd, 32768)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 4_000_000:
                    del output[:2_000_000]
            screen = readable(bytes(output))
            if all(token in screen for token in expected):
                matched = True
                if not navigation:
                    break
                if next_keys is None:
                    # Move through PiG's actual select UI; do not treat the
                    # command's static header as modal navigation proof.
                    os.write(fd, navigation["keys"])
                    next_keys = time.monotonic() + 0.2
                elif time.monotonic() > next_keys and all(x in screen for x in navigation["expected"]):
                    break
        shown = readable(bytes(output))[-8000:]
        if not matched:
            raise AssertionError(name + " did not render " + repr(expected) + "; last terminal output:\n" + shown[-2200:])
        if navigation:
            # Give keyboard selection a separate terminal-render assertion.
            # Check the *new* page's unique content, not the original choices.
            if not all(token in shown for token in navigation["expected"]):
                raise AssertionError(name + " modal navigation did not open " + repr(navigation["expected"]) + ":\n" + shown[-2200:])
        report["checks"].append({"name": name, "status": "PASS", "keyboard": command, "navigation": bool(navigation)})
    finally:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        time.sleep(0.1)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)


try:
    subprocess.run([str(shell), "install", "--home", str(home)], env=env, cwd=work,
                   check=True, timeout=120, capture_output=True, text=True)
    agent = home / ".pi"
    agent.mkdir(exist_ok=True)
    (agent / "models.json").write_text(json.dumps({"providers": {"study": {
        "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1",
        "apiKey": "fixture-only", "models": [{
            "id": "probe", "name": "Offline TUI fixture", "reasoning": False,
            "input": ["text"], "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 128000, "maxTokens": 4096,
        }],
    }}}))
    run_case("TUI /external control center", "/external",
             ["Configuration", "Runs", "Workflows", "Help", "Close"])
    run_case("TUI /external config selectors", "/external config",
             ["Global", "Agents", "Roles"],
             navigation={"keys": b"\x1b[B\x1b[B\r", "expected": ["Built-in", "Create a role"]})
    run_case("TUI /external mode", "/external mode", ["Mode"])
    run_case("TUI /external doctor", "/external doctor", ["CLI:"])
    run_case("TUI /external runs", "/external runs", ["No external runs"])
    report["status"] = "PASS"
except Exception as error:
    report["status"] = "FAIL"
    report["error"] = str(error)
    print("Native TUI fixture failed: " + str(error), file=sys.stderr)
    sys.exit_code = 1
finally:
    report_file.parent.mkdir(parents=True, exist_ok=True)
    report_file.write_text(json.dumps(report, indent=2) + "\n")
    shutil.rmtree(root, ignore_errors=True)

if report["status"] != "PASS":
    sys.exit(1)
print("Native PiG TUI checks passed: " + ", ".join(x["name"] for x in report["checks"]))
