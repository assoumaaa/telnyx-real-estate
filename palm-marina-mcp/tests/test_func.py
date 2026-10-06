"""Unit tests for the MCP server. Run with: pytest

The deployed function is checked separately with scripts/smoke.sh.
"""

import asyncio
import json
import logging

import pytest

# Import the way the Edge runtime does. A plain `from utils import ...` inside the
# package passes local script checks but fails here (see thought_process_and_issues.md).
from function import new

TEST_TOKEN = "test-secret-token"


def call(path, method="GET", body=None, token=TEST_TOKEN):
    """Drive the ASGI handler directly and return (status, parsed JSON body or None)."""
    raw = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else b""
    headers = []
    if token is not None:
        headers.append([b"authorization", f"Bearer {token}".encode()])
    out = {}

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
        else:
            out["body"] = json.loads(message["body"]) if message["body"] else None

    asyncio.run(new().handle({"type": "http", "path": path, "method": method, "headers": headers}, receive, send))
    return out["status"], out["body"]


def rpc(method, params=None, rpc_id=1):
    status, body = call("/mcp", "POST", {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}})
    assert status == 200
    assert body["id"] == rpc_id
    return body


def call_tool(name, arguments):
    result = rpc("tools/call", {"name": name, "arguments": arguments})["result"]
    return result["isError"], result["content"][0]["text"]


@pytest.fixture(autouse=True)
def _set_mcp_token(monkeypatch):
    monkeypatch.setenv("MCP_TOKEN", TEST_TOKEN)


def test_health_is_public_without_token():
    status, body = call("/health", "GET", token=None)
    assert status == 200
    assert body["status"] == "ok"


def test_missing_token_is_401():
    status, body = call("/mcp", "POST", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, token=None)
    assert status == 401
    assert body["error"] == "unauthorized"


def test_wrong_token_is_401():
    status, _ = call("/mcp", "POST", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, token="wrong")
    assert status == 401


def test_unauthorized_is_logged_without_token(caplog):
    caplog.set_level(logging.INFO, logger="palm-marina-mcp")
    call("/mcp", "POST", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, token=None)
    lines = [json.loads(r.message) for r in caplog.records if r.message.startswith("{")]
    assert len(lines) == 1
    assert lines[0]["outcome"] == "unauthorized"
    assert "test-secret-token" not in lines[0]


def test_initialize_echoes_protocol_version():
    result = rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}})["result"]
    assert result["protocolVersion"] == "2025-03-26"
    assert "tools" in result["capabilities"]


def test_notification_gets_202_and_no_body():
    assert call("/mcp", "POST", {"jsonrpc": "2.0", "method": "notifications/initialized"}) == (202, None)


def test_tools_list():
    tools = rpc("tools/list")["result"]["tools"]
    assert [t["name"] for t in tools] == ["search_listings"]


def test_search_returns_spoken_summary():
    is_error, text = call_tool("search_listings", {"purpose": "buy", "area": "Dubai Marina", "bedrooms": 2})
    assert not is_error
    assert text.startswith("I found one matching property")


def test_no_matches_is_not_an_error():
    is_error, text = call_tool("search_listings", {"purpose": "buy", "budget": 100000})
    assert not is_error
    assert "couldn't find" in text


def test_area_must_be_a_known_area():
    is_error, text = call_tool("search_listings", {"area": "JBR"})
    assert is_error
    assert "Jumeirah Beach Residence" in text  # the error lists the valid areas so the model can retry


def test_area_list_comes_from_listings():
    tools = rpc("tools/list")["result"]["tools"]
    assert "Jumeirah Beach Residence" in tools[0]["inputSchema"]["properties"]["area"]["enum"]


def test_bad_arguments():
    is_error, text = call_tool("search_listings", {"budget": "cheap"})
    assert is_error
    assert "budget" in text


def test_unknown_tool():
    is_error, _ = call_tool("delete_everything", {})
    assert is_error


def test_unknown_method():
    assert rpc("resources/list")["error"]["code"] == -32601


def test_invalid_json_and_non_object_body():
    assert call("/mcp", "POST", b"{not json")[1]["error"]["code"] == -32700
    status, body = call("/mcp", "POST", [1, 2])
    assert status == 400
    assert body["error"]["code"] == -32600


def test_one_json_log_line_per_request(caplog):
    caplog.set_level(logging.INFO, logger="palm-marina-mcp")
    call_tool("search_listings", {"budget": "cheap"})
    lines = [json.loads(r.message) for r in caplog.records if r.message.startswith("{")]
    assert len(lines) == 1
    assert lines[0]["rpc_method"] == "tools/call"
    assert lines[0]["outcome"] == "bad_args"


def test_prices_are_not_rounded():
    # A rounding bug once read 2,550,000 as "2.5 million" to callers.
    from function.utils import _format_amount

    assert _format_amount(2_550_000) == "2.55 million"
    assert _format_amount(3_000_000) == "3 million"
    assert _format_amount(95_000) == "95 thousand"


def test_many_matches_describes_only_three():
    _, text = call_tool("search_listings", {"purpose": "rent"})
    assert text.startswith("I found 4 matching properties. Here are the first 3.")
    assert "Option 3" in text and "Option 4" not in text
