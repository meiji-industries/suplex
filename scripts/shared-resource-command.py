#!/usr/bin/env python3
"""Run a cooperating command under a host lock until its process group exits."""
import argparse
import fcntl
import hashlib
import os
import signal
import subprocess
import tempfile
import time


def group_alive(group):
    result = subprocess.run(["ps", "-axo", "pgid=,stat="], capture_output=True, text=True, check=True)
    return any(int(fields[0]) == group and not fields[1].startswith("Z")
               for line in result.stdout.splitlines() if len(fields := line.split()) == 2)


def supervise(resource, command):
    directory = os.path.join(tempfile.gettempdir(), "forge-resource-locks-" + str(os.getuid()))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    key = os.path.realpath(resource) if os.path.isabs(resource) else resource
    path = os.path.join(directory, hashlib.sha256(key.encode()).hexdigest() + ".lock")
    with open(path, "a") as lock:
        os.chmod(path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        child = subprocess.Popen(command, start_new_session=True, pass_fds=(lock.fileno(),))

        def terminate(signum, _frame):
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass

        signal.signal(signal.SIGTERM, terminate)
        signal.signal(signal.SIGINT, terminate)
        code = child.wait()
        while group_alive(child.pid):
            time.sleep(0.05)
        return code if code >= 0 else 128 - code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resource", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not args.resource or not command:
        parser.error("a resource key and command are required")
    read_end, write_end = os.pipe()
    guardian = os.fork()
    if guardian == 0:
        os.close(read_end)
        os.setsid()
        try:
            code = supervise(args.resource, command)
        except Exception as error:
            print("Shared resource command failed: " + str(error), file=__import__("sys").stderr)
            code = 1
        try:
            os.write(write_end, str(code).encode())
        except BrokenPipeError:
            pass
        os._exit(code)
    os.close(write_end)

    def forward(signum, _frame):
        try:
            os.kill(guardian, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    result = os.read(read_end, 32)
    os.close(read_end)
    os.waitpid(guardian, 0)
    return int(result) if result else 1


if __name__ == "__main__":
    raise SystemExit(main())
