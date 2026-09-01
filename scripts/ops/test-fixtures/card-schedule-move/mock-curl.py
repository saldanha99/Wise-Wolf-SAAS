#!/usr/bin/env python3
"""Stateful Asaas HTTP double for the card schedule move operator tests.

The double deliberately records only method, path, logical step, and request
body. It never reads or records the access-token header file.
"""

from __future__ import annotations

import json
import os
import signal
import sys
from copy import deepcopy
from pathlib import Path
from urllib.parse import urlsplit


STATE_DIR = Path(os.environ["MOCK_STATE_DIR"])
PROVIDER_FILE = STATE_DIR / "provider.json"
BEHAVIORS_FILE = STATE_DIR / "behaviors.json"
CALLS_FILE = STATE_DIR / "http-calls.jsonl"
DB_FILE = STATE_DIR / "db.json"


def read_json(path: Path, default=None):
    if not path.exists():
        return deepcopy(default)
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def append_call(value) -> None:
    with CALLS_FILE.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, separators=(",", ":"), sort_keys=True))
        stream.write("\n")


def parse_cli(argv: list[str]):
    method = "GET"
    url = ""
    output = ""
    body_file = ""
    index = 0
    while index < len(argv):
        value = argv[index]
        if value in {"--request", "--url", "--output", "--data-binary"}:
            if index + 1 >= len(argv):
                raise SystemExit(2)
            argument = argv[index + 1]
            if value == "--request":
                method = argument.upper()
            elif value == "--url":
                url = argument
            elif value == "--output":
                output = argument
            else:
                body_file = argument[1:] if argument.startswith("@") else argument
            index += 2
            continue
        # All other curl options used by the operator are irrelevant to the
        # provider double, including --header @<0600 file>.
        index += 1
    if not url or not output:
        raise SystemExit(2)
    body = None
    if body_file:
        body = json.loads(Path(body_file).read_text(encoding="utf-8"))
    return method, url, Path(output), body


def response(output: Path, status: int, payload, exit_code: int = 0) -> None:
    output.write_text(
        json.dumps(payload, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    sys.stdout.write(f"{status:03d}")
    raise SystemExit(exit_code)


def safe_path(url: str) -> str:
    parsed = urlsplit(url)
    path = parsed.path
    if path.startswith("/v3"):
        path = path[3:]
    return path + (f"?{parsed.query}" if parsed.query else "")


def logical_step(path: str, body) -> str | None:
    if body is None:
        return None
    if path.startswith("/payments/"):
        return (
            "MOVE_PAYMENT_TO_TARGET"
            if body.get("dueDate") == "2026-09-10"
            else "RESTORE_ORIGINAL_PAYMENT"
        )
    if path.startswith("/subscriptions/"):
        return (
            "UPDATE_TARGET_SCHEDULE"
            if body.get("nextDueDate") == "2026-10-10"
            else "RESTORE_ORIGINAL_SCHEDULE"
        )
    return None


def pop_behavior() -> str:
    behaviors = read_json(BEHAVIORS_FILE, [])
    if not behaviors:
        return "unexpected_put"
    behavior = behaviors.pop(0)
    write_json(BEHAVIORS_FILE, behaviors)
    return str(behavior)


def mark_causal_target_event() -> None:
    database = read_json(DB_FILE, {})
    database["causal_target_event"] = True
    write_json(DB_FILE, database)


def generated_payment(provider, due_date: str, payment_id: str):
    original = provider["payment"]
    generated = deepcopy(original)
    generated.update(
        {
            "id": payment_id,
            "dueDate": due_date,
            "originalDueDate": due_date,
        }
    )
    return generated


def apply_success(provider, path: str, body, behavior: str):
    if path.startswith("/payments/"):
        provider["payment"].update(body)
        provider["payments"][0] = deepcopy(provider["payment"])
        return provider["payment"]

    if path.startswith("/subscriptions/"):
        provider["subscription"].update(body)
        if behavior in {"success_update_immediate_oct", "success_update_extra"}:
            provider["subscription"]["nextDueDate"] = "2026-11-10"
            october = generated_payment(provider, "2026-10-10", "pay_generated_oct")
            provider["payments"] = [deepcopy(provider["payment"]), october]
            if behavior == "success_update_extra":
                provider["payments"].append(
                    generated_payment(provider, "2026-11-10", "pay_unexpected_nov")
                )
        return provider["subscription"]

    raise RuntimeError(f"unexpected mutation path: {path}")


def main() -> None:
    method, url, output, body = parse_cli(sys.argv[1:])
    path = safe_path(url)
    call = {
        "method": method,
        "path": path,
        "logicalStep": logical_step(path, body),
        "body": body,
    }
    append_call(call)
    provider = read_json(PROVIDER_FILE)

    if method == "GET":
        clean_path = path.split("?", 1)[0]
        if clean_path.startswith("/subscriptions/") and clean_path.endswith("/payments"):
            payload = {
                "object": "list",
                "hasMore": None,
                "totalCount": len(provider["payments"]),
                "limit": 100,
                "offset": 0,
                "data": provider["payments"],
            }
        elif clean_path.startswith("/subscriptions/"):
            payload = provider["subscription"]
        elif clean_path.startswith("/payments/"):
            payload = provider["payment"]
        else:
            response(output, 404, {"errors": [{"code": "not_found"}]})
            return
        response(output, 200, payload)

    if method == "DELETE":
        response(output, 599, {"errors": [{"code": "delete_forbidden"}]})

    if method != "PUT":
        response(output, 405, {"errors": [{"code": "method_not_allowed"}]})

    behavior = pop_behavior()
    if behavior == "crash_before_response":
        # mark-submitting already committed. Kill only the operator shell which
        # invoked this curl process; the parent test process stays alive.
        os.kill(os.getppid(), signal.SIGKILL)
        raise SystemExit(137)

    if behavior == "timeout_no_effect":
        response(output, 0, {"errors": []}, exit_code=28)

    status_by_behavior = {
        "http_408_no_effect": 408,
        "http_429_no_effect": 429,
        "http_503_no_effect": 503,
        "http_200_no_effect": 200,
        "http_400_no_effect": 400,
        "http_400_causal_event": 400,
    }
    if behavior in status_by_behavior:
        if behavior == "http_400_causal_event":
            mark_causal_target_event()
        status = status_by_behavior[behavior]
        payload = (
            {"id": provider["payment"]["id"], "status": "PENDING"}
            if status == 200
            else {"errors": [{"code": "mock_rejection", "description": "fixture"}]}
        )
        response(output, status, payload)

    if behavior in {"success", "success_update_immediate_oct", "success_update_extra"}:
        payload = apply_success(provider, path, body or {}, behavior)
        write_json(PROVIDER_FILE, provider)
        response(output, 200, payload)

    response(output, 598, {"errors": [{"code": "unexpected_put_behavior"}]})


if __name__ == "__main__":
    main()
