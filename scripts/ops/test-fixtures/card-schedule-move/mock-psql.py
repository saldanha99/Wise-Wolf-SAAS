#!/usr/bin/env python3
"""Small transactional state-machine double for operator/SQL boundary tests."""

from __future__ import annotations

import json
import os
import sys
from copy import deepcopy
from pathlib import Path


STATE_DIR = Path(os.environ["MOCK_STATE_DIR"])
DB_FILE = STATE_DIR / "db.json"
DB_CALLS_FILE = STATE_DIR / "db-calls.jsonl"


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


def emit(value) -> None:
    if value is not None:
        sys.stdout.write(json.dumps(value, separators=(",", ":"), sort_keys=True))
        sys.stdout.write("\n")


def refuse(message: str) -> None:
    sys.stderr.write(f"mock psql refused: {message}\n")
    raise SystemExit(1)


def parse_vars(argv: list[str]):
    result = {}
    index = 0
    while index < len(argv):
        if argv[index] == "-v" and index + 1 < len(argv):
            value = argv[index + 1]
            if "=" in value:
                key, content = value.split("=", 1)
                result[key] = content
            index += 2
        else:
            index += 1
    return result


def json_var(values, name, default=None):
    content = values.get(name)
    return deepcopy(default) if content is None else json.loads(content)


def append_db_call(kind: str, values) -> None:
    safe = {
        "kind": kind,
        "stepKind": values.get("step_kind"),
        "stepStatus": values.get("step_status"),
    }
    with DB_CALLS_FILE.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(safe, separators=(",", ":"), sort_keys=True))
        stream.write("\n")


def sql_kind(sql: str) -> str:
    markers = [
        ("do $preflight$", "preflight"),
        ("do $prepare$", "prepare"),
        ("do $submit$", "mark"),
        ("do $finish$", "finish"),
        ("do $noop$", "noop"),
        ("do $compensate$", "compensate"),
        ("do $abort$", "abort"),
        ("do $reconcile$", "reconcile"),
        ("'integrationLive'", "context"),
        ("'operationStatus'", "status"),
    ]
    for marker, kind in markers:
        if marker in sql:
            return kind
    return "unknown"


def initial_steps(original_subscription, target_subscription, original_payment, target_payment):
    return [
        {
            "ordinal": 10,
            "step_kind": "MOVE_PAYMENT_TO_TARGET",
            "status": "READY",
            "submit_attempt_count": 0,
            "expected_before": original_payment,
            "desired_after": target_payment,
            "provider_request": {
                "method": "PUT",
                "path": f"/payments/{original_payment['id']}",
                "body": {
                    "billingType": "CREDIT_CARD",
                    "value": original_payment["value"],
                    "dueDate": target_payment["dueDate"],
                },
            },
        },
        {
            "ordinal": 20,
            "step_kind": "UPDATE_TARGET_SCHEDULE",
            "status": "READY",
            "submit_attempt_count": 0,
            "expected_before": original_subscription,
            "desired_after": target_subscription,
            "provider_request": {
                "method": "PUT",
                "path": f"/subscriptions/{original_subscription['id']}",
                "body": {
                    "nextDueDate": target_subscription["nextDueDate"],
                    "endDate": target_subscription["endDate"],
                },
            },
        },
        {
            "ordinal": 30,
            "step_kind": "RESTORE_ORIGINAL_SCHEDULE",
            "status": "READY",
            "submit_attempt_count": 0,
            "expected_before": target_subscription,
            "desired_after": original_subscription,
            "provider_request": {
                "method": "PUT",
                "path": f"/subscriptions/{original_subscription['id']}",
                "body": {
                    "nextDueDate": original_subscription["nextDueDate"],
                    "endDate": original_subscription["endDate"],
                },
            },
        },
        {
            "ordinal": 40,
            "step_kind": "RESTORE_ORIGINAL_PAYMENT",
            "status": "READY",
            "submit_attempt_count": 0,
            "expected_before": target_payment,
            "desired_after": original_payment,
            "provider_request": {
                "method": "PUT",
                "path": f"/payments/{original_payment['id']}",
                "body": {
                    "billingType": "CREDIT_CARD",
                    "value": original_payment["value"],
                    "dueDate": original_payment["dueDate"],
                },
            },
        },
    ]


def step(database, name: str):
    for item in database["steps"]:
        if item["step_kind"] == name:
            return item
    refuse(f"missing step {name}")


def target_schedule_exact(database, subscription, payments) -> bool:
    desired = database["operation"]["target_subscription_snapshot"]
    if any(subscription.get(key) != value for key, value in desired.items() if key != "nextDueDate"):
        return False
    target_payment = database["operation"]["target_payment_snapshot"]
    original_next = database["operation"]["original_next_due_date"]
    target_next = database["operation"]["target_next_due_date"]
    if subscription.get("nextDueDate") == target_next:
        return payments == [target_payment]
    if subscription.get("nextDueDate") != original_next or len(payments) != 2:
        return False
    if payments[0] != target_payment:
        return False
    october = payments[1]
    expected_reference = database["operation"]["original_payment_snapshot"].get("externalReference")
    return (
        october.get("id") != target_payment.get("id")
        and october.get("customer") == target_payment.get("customer")
        and october.get("subscription") == target_payment.get("subscription")
        and october.get("status") == "PENDING"
        and october.get("dueDate") == database["operation"]["old_due_date"]
        and october.get("originalDueDate") == database["operation"]["old_due_date"]
        and october.get("billingType") == "CREDIT_CARD"
        and october.get("externalReference") in {None, expected_reference}
        and october.get("value") == database["operation"]["expected_value"]
        and october.get("deleted") is False
        and all(
            october.get(key) is None
            for key in ("paymentDate", "clientPaymentDate", "confirmedDate", "creditDate")
        )
    )


def prepare(values) -> None:
    original_subscription = json_var(values, "original_subscription_snapshot")
    original_payment = json_var(values, "original_payment_snapshot")
    original_payments = json_var(values, "original_payments_snapshot")
    target_subscription = deepcopy(original_subscription)
    target_subscription.update(
        {
            "nextDueDate": values["old_due_date"],
            "endDate": values["target_end_date"],
        }
    )
    target_payment = deepcopy(original_payment)
    target_payment["dueDate"] = values["target_due_date"]
    database = {
        "operation": {
            "status": "READY",
            "expected_value": float(values["expected_value"]),
            "old_due_date": values["old_due_date"],
            "target_due_date": values["target_due_date"],
            "target_next_due_date": values["old_due_date"],
            "original_next_due_date": values["original_next_due_date"],
            "target_end_date": values["target_end_date"],
            "original_end_date": values["original_end_date"],
            "original_subscription_snapshot": original_subscription,
            "target_subscription_snapshot": target_subscription,
            "original_payment_snapshot": original_payment,
            "target_payment_snapshot": target_payment,
            "original_payments_snapshot": original_payments,
        },
        "steps": initial_steps(
            original_subscription, target_subscription, original_payment, target_payment
        ),
        "claim_present": True,
        "local_due": values["old_due_date"],
        "causal_target_event": False,
        "causal_restore_event": False,
        "integration_live": True,
    }
    write_json(DB_FILE, database)
    emit(
        {
            "ok": True,
            "status": "READY",
            "operationId": "00000000-0000-4000-8000-000000000099",
            "targetClaimFingerprint": "a" * 64,
            "stepCount": 4,
        }
    )


def context(database) -> None:
    if not database:
        return
    emit(
        {
            "operation": database["operation"],
            "claim": {"status": "BOUND"} if database.get("claim_present") else None,
            "integrationLive": database.get("integration_live", True),
            "steps": database["steps"],
        }
    )


def mark(database, values) -> None:
    name = values["step_kind"]
    item = step(database, name)
    required = {
        "MOVE_PAYMENT_TO_TARGET": "READY",
        "UPDATE_TARGET_SCHEDULE": "PAYMENT_MOVED",
        "RESTORE_ORIGINAL_SCHEDULE": "COMPENSATING",
        "RESTORE_ORIGINAL_PAYMENT": "ORIGINAL_SCHEDULE_RESTORED",
    }[name]
    if database["operation"]["status"] != required or item["status"] != "READY":
        refuse("submit transition")
    if item["submit_attempt_count"] != 0:
        refuse("second submit attempt")

    observed = json_var(values, "observed_before")
    subscription = json_var(values, "subscription_observed")
    payment = json_var(values, "payment_observed")
    payments = json_var(values, "subscription_payments")
    operation = database["operation"]
    if observed != item["expected_before"]:
        refuse("observed entity fence")
    if name == "MOVE_PAYMENT_TO_TARGET":
        exact = (
            subscription == operation["original_subscription_snapshot"]
            and payment == operation["original_payment_snapshot"]
            and payments == operation["original_payments_snapshot"]
            and database["local_due"] == operation["old_due_date"]
        )
    else:
        exact = (
            payment == operation["target_payment_snapshot"]
            and payments == [operation["target_payment_snapshot"]]
            and database["local_due"] in {
                operation["target_due_date"],
                operation["old_due_date"],
            }
        )
        if name == "UPDATE_TARGET_SCHEDULE":
            exact = exact and subscription == operation["original_subscription_snapshot"]
        elif name == "RESTORE_ORIGINAL_SCHEDULE":
            exact = exact and subscription == operation["target_subscription_snapshot"]
        else:
            exact = exact and subscription == operation["original_subscription_snapshot"]
    if not exact:
        refuse("provider trio fence")
    if name != "MOVE_PAYMENT_TO_TARGET" and not database["causal_target_event"]:
        refuse("target webhook fence")

    item["status"] = "SUBMITTING"
    item["submit_attempt_count"] = 1
    database["operation"]["status"] = {
        "MOVE_PAYMENT_TO_TARGET": "MOVING_PAYMENT",
        "UPDATE_TARGET_SCHEDULE": "UPDATING_TARGET_SCHEDULE",
        "RESTORE_ORIGINAL_SCHEDULE": "RESTORING_ORIGINAL_SCHEDULE",
        "RESTORE_ORIGINAL_PAYMENT": "RESTORING_ORIGINAL_PAYMENT",
    }[name]
    write_json(DB_FILE, database)
    emit(
        {
            "requestFingerprint": "b" * 64,
            "providerRequest": item["provider_request"],
            "status": "SUBMITTING",
            "submitAttemptCount": 1,
        }
    )


def finish(database, values) -> None:
    name = values["step_kind"]
    result = values["step_status"]
    item = step(database, name)
    if item["status"] not in {"SUBMITTING", "UNKNOWN"}:
        refuse("finish transition")
    observed = json_var(values, "observed_after")
    payments = json_var(values, "subscription_payments", [])
    operation = database["operation"]

    if result == "SUCCEEDED":
        if name == "UPDATE_TARGET_SCHEDULE":
            exact = target_schedule_exact(database, observed, payments)
        elif name == "MOVE_PAYMENT_TO_TARGET":
            exact = observed == item["desired_after"] and payments == [operation["target_payment_snapshot"]]
        elif name == "RESTORE_ORIGINAL_SCHEDULE":
            exact = observed == item["desired_after"] and payments == [operation["target_payment_snapshot"]]
        else:
            exact = observed == item["desired_after"] and payments == operation["original_payments_snapshot"]
        if not exact:
            refuse("success evidence")
    elif result == "FAILED":
        if observed != item["expected_before"]:
            refuse("failed mutation changed provider")
        if name == "MOVE_PAYMENT_TO_TARGET":
            if (
                payments != operation["original_payments_snapshot"]
                or database["local_due"] != operation["old_due_date"]
                or database["causal_target_event"]
            ):
                refuse("target claim cleanup fence")
        elif name == "UPDATE_TARGET_SCHEDULE":
            if payments != [operation["target_payment_snapshot"]]:
                refuse("update rejection evidence")
    elif result not in {"UNKNOWN", "BLOCKED"}:
        refuse("unsupported finish result")

    item["status"] = result
    if result == "UNKNOWN":
        operation["status"] = "UNKNOWN"
    elif result == "BLOCKED":
        operation["status"] = "BLOCKED"
    elif name == "MOVE_PAYMENT_TO_TARGET" and result == "SUCCEEDED":
        operation["status"] = "PAYMENT_MOVED"
        database["local_due"] = operation["target_due_date"]
        database["causal_target_event"] = True
    elif name == "MOVE_PAYMENT_TO_TARGET" and result == "FAILED":
        operation["status"] = "FAILED"
        database["claim_present"] = False
    elif name == "UPDATE_TARGET_SCHEDULE" and result == "SUCCEEDED":
        operation["status"] = "TARGET_SCHEDULED"
    elif name == "UPDATE_TARGET_SCHEDULE" and result == "FAILED":
        operation["status"] = "COMPENSATING"
    elif name == "RESTORE_ORIGINAL_SCHEDULE" and result == "SUCCEEDED":
        operation["status"] = "ORIGINAL_SCHEDULE_RESTORED"
    elif name == "RESTORE_ORIGINAL_PAYMENT" and result == "SUCCEEDED":
        operation["status"] = "RESTORING_ORIGINAL_PAYMENT"
        database["local_due"] = operation["old_due_date"]
        database["causal_restore_event"] = True
    else:
        operation["status"] = "BLOCKED"
    write_json(DB_FILE, database)
    emit({"status": operation["status"], "stepStatus": result})


def noop(database, values) -> None:
    name = values["step_kind"]
    item = step(database, name)
    if item["status"] != "READY" or database["operation"]["status"] != "COMPENSATING":
        refuse("noop transition")
    subscription = json_var(values, "subscription_observed")
    payment = json_var(values, "payment_observed")
    payments = json_var(values, "subscription_payments")
    operation = database["operation"]
    if name != "RESTORE_ORIGINAL_SCHEDULE" or not (
        subscription == operation["original_subscription_snapshot"]
        and payment == operation["target_payment_snapshot"]
        and payments == [operation["target_payment_snapshot"]]
    ):
        refuse("noop provider trio")
    item["status"] = "SUCCEEDED"
    database["operation"]["status"] = "ORIGINAL_SCHEDULE_RESTORED"
    write_json(DB_FILE, database)
    emit({"status": "ORIGINAL_SCHEDULE_RESTORED", "stepStatus": "SUCCEEDED"})


def compensate(database, values) -> None:
    if database["operation"]["status"] != "PAYMENT_MOVED":
        refuse("compensation transition")
    operation = database["operation"]
    if not (
        json_var(values, "subscription_observed") == operation["original_subscription_snapshot"]
        and json_var(values, "payment_observed") == operation["target_payment_snapshot"]
        and json_var(values, "subscription_payments") == [operation["target_payment_snapshot"]]
    ):
        refuse("compensation provider trio")
    update = step(database, "UPDATE_TARGET_SCHEDULE")
    update["status"] = "FAILED"
    database["operation"]["status"] = "COMPENSATING"
    write_json(DB_FILE, database)
    emit({"status": "COMPENSATING", "updateStepStatus": "FAILED"})


def reconcile(database, values) -> None:
    operation = database["operation"]
    subscription = json_var(values, "subscription_observed")
    payment = json_var(values, "payment_observed")
    payments = json_var(values, "subscription_payments")
    if operation["status"] == "RESTORING_ORIGINAL_PAYMENT":
        exact = (
            subscription == operation["original_subscription_snapshot"]
            and payment == operation["original_payment_snapshot"]
            and payments == operation["original_payments_snapshot"]
            and database["local_due"] == operation["old_due_date"]
            and database["causal_restore_event"]
        )
        if not exact:
            refuse("restore final evidence")
        operation["status"] = "COMPENSATED"
        database["claim_present"] = False
    elif operation["status"] in {"TARGET_SCHEDULED", "AWAITING_LOCAL_RECONCILIATION"}:
        exact = (
            payment == operation["target_payment_snapshot"]
            and target_schedule_exact(database, subscription, payments)
            and database["local_due"] == operation["target_due_date"]
            and database["causal_target_event"]
        )
        if not exact:
            refuse("target final evidence")
        operation["status"] = "COMPLETED"
    else:
        refuse("reconcile transition")
    write_json(DB_FILE, database)
    emit({"status": operation["status"]})


def main() -> None:
    values = parse_vars(sys.argv[1:])
    sql = sys.stdin.read()
    kind = sql_kind(sql)
    append_db_call(kind, values)
    database = read_json(DB_FILE, None)

    if kind == "context":
        context(database)
    elif kind == "preflight":
        emit(
            {
                "ok": True,
                "integrationSnapshot": {
                    "integrationId": "00000000-0000-4000-8000-000000000088",
                    "version": 1,
                    "mode": "PLATFORM_MANAGED_ROOT",
                    "providerEnvironment": values.get("provider_environment"),
                    "asaasBaseUrl": values.get("asaas_base_url"),
                    "localGuardBaseline": {"fixture": True},
                },
            }
        )
    elif kind == "prepare":
        if database:
            refuse("duplicate prepare")
        prepare(values)
    elif not database:
        refuse("operation missing")
    elif kind == "mark":
        mark(database, values)
    elif kind == "finish":
        finish(database, values)
    elif kind == "noop":
        noop(database, values)
    elif kind == "compensate":
        compensate(database, values)
    elif kind == "reconcile":
        reconcile(database, values)
    elif kind == "status":
        emit(
            {
                "operationStatus": database["operation"]["status"],
                "targetClaimReleased": not database["claim_present"],
                "steps": [
                    {
                        "stepKind": item["step_kind"],
                        "status": item["status"],
                        "submitAttemptCount": item["submit_attempt_count"],
                    }
                    for item in database["steps"]
                ],
            }
        )
    else:
        refuse(f"unrecognized SQL fixture: {kind}")


if __name__ == "__main__":
    main()
