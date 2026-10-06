"""Unit tests for the dynamic-variables webhook. Run with: pytest.

The deployed function is checked separately against real Telnyx payloads.
"""

import asyncio
import json
import logging
import re

from function import new


def call(path, method="GET", body=None):
    """Drive the ASGI handler directly and return (status, parsed JSON body or None)."""
    raw = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b""
    out = {}

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
        else:
            out["body"] = json.loads(message["body"]) if message["body"] else None

    asyncio.run(new().handle({"type": "http", "path": path, "method": method}, receive, send))
    return out["status"], out["body"]


def init_event(caller_number, channel="phone_call"):
    return {
        "data": {
            "event_type": "assistant.initialization",
            "payload": {
                "telnyx_conversation_channel": channel,
                "telnyx_end_user_target": caller_number,
                "call_control_id": "v3:test",
            },
        }
    }


TIME_RE = re.compile(r"^\d{1,2}:\d{2} (AM|PM)$")


def test_returning_caller_is_recognized():
    status, body = call("/", "POST", init_event("+447911123456"))
    assert status == 200
    dv = body["dynamic_variables"]
    assert dv["caller_name"] == "James"
    assert dv["is_returning_caller"] == "true"
    assert dv["caller_country"] == "United Kingdom"
    assert TIME_RE.match(dv["caller_local_time"])
    assert TIME_RE.match(dv["dubai_time"])
    assert "Dubai Marina" in dv["last_time_note"]


def test_new_caller_gets_safe_defaults():
    status, body = call("/", "POST", init_event("+12125551234"))
    assert status == 200
    dv = body["dynamic_variables"]
    assert dv["caller_name"] == ""
    assert dv["is_returning_caller"] == "false"
    assert dv["caller_country"] == "United States"
    assert TIME_RE.match(dv["caller_local_time"])
    assert TIME_RE.match(dv["dubai_time"])
    assert dv["last_time_note"] == ""


def test_bad_body_returns_safe_defaults():
    status, body = call("/", "POST", b"{not json")
    assert status == 200
    dv = body["dynamic_variables"]
    assert dv["is_returning_caller"] == "false"
    assert dv["caller_name"] == ""


def test_logs_mask_the_caller_number(caplog):
    caplog.set_level(logging.INFO, logger="palm-marina-webhook")
    call("/", "POST", init_event("+447911123456"))

    from function.utils import mask_number

    assert mask_number("+447911123456") == "+44****56"
    masked_unknown = mask_number("+9999999999")
    assert "+9999999999" not in masked_unknown
    assert not any(ch.isdigit() for ch in masked_unknown)

    lines = [r.message for r in caplog.records if r.message.startswith("{")]
    assert len(lines) == 1
    log = json.loads(lines[0])
    assert set(log) == {"caller_masked", "channel", "is_returning", "outcome"}
    assert log["caller_masked"] == "+44****56"
    assert log["is_returning"] is True
    assert log["outcome"] == "returning_caller"
    assert "+447911123456" not in lines[0]
