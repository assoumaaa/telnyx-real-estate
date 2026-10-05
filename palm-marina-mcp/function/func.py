"""Palm & Marina Realty MCP server on Telnyx Edge Compute.

Exposes a single tool, search_listings, that lets the AI phone concierge find
fictional Dubai properties for sale or rent and describe them out loud.
"""

import json
import logging

from .utils import filter_listings, format_for_voice

logger = logging.getLogger("palm-marina-mcp")
logger.setLevel(logging.INFO)


TOOLS = [
    {
        "name": "search_listings",
        "description": (
            "Search available properties for sale or rent in Dubai. "
            "Returns how many properties match and describes up to 3 of them in a short, voice-friendly summary. "
            "All amounts are in UAE dirhams; for rentals the price is the annual rent."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "purpose": {
                    "type": "string",
                    "enum": ["buy", "rent"],
                    "description": "Whether the caller wants to buy or to rent. Omit to search both.",
                },
                "area": {
                    "type": "string",
                    "description": "Dubai area name, e.g. 'Dubai Marina', 'Palm Jumeirah', 'Downtown Dubai'. Case-insensitive substring match.",
                },
                "bedrooms": {
                    "type": "integer",
                    "description": "Exact number of bedrooms. Use 0 for a studio.",
                },
                "budget": {
                    "type": "number",
                    "description": "Maximum price in UAE dirhams. For rentals this is the maximum annual rent. Properties at or below this price are returned.",
                },
            },
        },
    },
]


def new():
    """new is the only method that must be implemented by a Function."""
    return Function()


class Function:
    def __init__(self):
        """Optional initialization. See start() for the startup hook."""

    async def handle(self, scope, receive, send):
        """Serve MCP JSON-RPC on POST /mcp, plus GET /health.

        Async because the ASGI protocol requires async send/receive.
        Each MCP call emits one JSON log line with what only our code knows (method, tool,
        outcome). Status and latency come from the platform: telnyx-edge logs --type invocations.
        """
        method = scope.get("method", "GET")
        path = scope.get("path", "/")

        if scope.get("type") != "http":
            await self._respond(send, 400, {"error": "not http"})
            return

        if path == "/health" and method == "GET":
            await self._respond(send, 200, {"status": "ok", "tools": len(TOOLS)})
            return

        if path != "/mcp":
            await self._respond(send, 404, {"error": "not found"})
            return

        if method != "POST":
            await self._respond(send, 405, {"error": "use POST for MCP JSON-RPC"})
            return

        log = {}
        try:
            body = await self._read_body(receive)
            status, payload = self._handle_rpc(body, log)
            await self._respond(send, status, payload)
        except Exception as exc:
            logger.exception("unhandled error in handle")
            log["outcome"] = "exception"
            log["error"] = str(exc)
            await self._respond(send, 500, {"error": "internal server error"})
        finally:
            logger.info(json.dumps(log))

    def start(self, cfg):
        """start is an optional method which is called when a new Function
        instance is started, such as when scaling up or during an update.
        Provided is a dictionary containing all environmental configuration.

        This method is synchronous (unlike handle) as it's a simple initialization hook.
        """
        logger.info("Function starting")

    def stop(self):
        """stop is an optional method which is called when a function is
        stopped, such as when scaled down, updated, or manually canceled.
        """
        logger.info("Function stopping")

    # --- internals -------------------------------------------------------

    def _handle_rpc(self, body, log):
        """Handle one MCP JSON-RPC message. Returns (http_status, payload or None)."""
        try:
            msg = json.loads(body)
        except json.JSONDecodeError:
            log["outcome"] = "invalid_json"
            log["error"] = "invalid json in request body"
            return 400, _rpc_error(None, -32700, "Parse error")

        if not isinstance(msg, dict):
            log["outcome"] = "invalid_request"
            log["error"] = "body is not a JSON-RPC object"
            return 400, _rpc_error(None, -32600, "Invalid request: expected a single JSON-RPC object")

        rpc_method = msg.get("method")
        rpc_id = msg.get("id")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        log["rpc_method"] = rpc_method

        if "id" not in msg:
            log["outcome"] = "accepted"
            return 202, None

        if rpc_method == "initialize":
            log["outcome"] = "ok"
            return 200, _rpc_result(
                rpc_id,
                {
                    "protocolVersion": params.get("protocolVersion") or "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "palm-marina-mcp", "version": "0.2.0"},
                },
            )

        if rpc_method == "ping":
            log["outcome"] = "ok"
            return 200, _rpc_result(rpc_id, {})

        if rpc_method == "tools/list":
            log["outcome"] = "ok"
            return 200, _rpc_result(rpc_id, {"tools": TOOLS})

        if rpc_method != "tools/call":
            log["outcome"] = "unknown_method"
            log["error"] = f"method not found: {rpc_method}"
            return 200, _rpc_error(rpc_id, -32601, f"Method not found: {rpc_method}")

        tool_name = params.get("name", "")
        tool_args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        log["tool"] = tool_name
        log["arguments"] = {k: v for k, v in tool_args.items() if k in ("purpose", "area", "bedrooms", "budget")}

        result = self._execute_tool(tool_name, tool_args)
        if "error" in result:
            log["outcome"] = "unknown_tool" if result["error"].startswith("Unknown tool") else "bad_args"
            log["error"] = result["error"]
            return 200, _rpc_result(
                rpc_id,
                {
                    "content": [{"type": "text", "text": result["error"]}],
                    "isError": True,
                },
            )

        log["outcome"] = "no_matches" if result["count"] == 0 else "ok"
        log["count"] = result["count"]
        return 200, _rpc_result(
            rpc_id,
            {
                "content": [{"type": "text", "text": result["summary"]}],
                "isError": False,
            },
        )

    def _execute_tool(self, name, args):
        if name != "search_listings":
            return {"error": f"Unknown tool: {name}"}

        purpose = args.get("purpose")
        if purpose and purpose not in ("buy", "rent"):
            return {"error": f"purpose must be 'buy' or 'rent', got {purpose!r}"}

        area = args.get("area")
        if area and not isinstance(area, str):
            return {"error": f"area must be a string, got {type(area).__name__}"}

        bedrooms = args.get("bedrooms")
        if bedrooms is not None:
            try:
                bedrooms = int(bedrooms)
                if bedrooms < 0:
                    return {"error": "bedrooms must be 0 or more"}
            except (ValueError, TypeError):
                return {"error": f"bedrooms must be an integer, got {bedrooms!r}"}

        budget = args.get("budget")
        if budget is not None:
            try:
                budget = float(budget)
                if budget <= 0:
                    return {"error": "budget must be greater than 0"}
            except (ValueError, TypeError):
                return {"error": f"budget must be a number, got {budget!r}"}

        matches = filter_listings(purpose=purpose, area=area, bedrooms=bedrooms, budget=budget)
        return {"summary": format_for_voice(matches), "count": len(matches)}

    async def _read_body(self, receive):
        body = b""
        while True:
            message = await receive()
            if message.get("type") == "http.request":
                body += message.get("body", b"")
                if not message.get("more_body", False):
                    break
        return body

    async def _respond(self, send, status, data):
        """Send a JSON response, or an empty body when data is None (e.g. 202 for notifications)."""
        headers = [[b"content-type", b"application/json"]] if data is not None else []
        payload = json.dumps(data).encode() if data is not None else b""
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": headers,
            }
        )
        await send({"type": "http.response.body", "body": payload})


def _rpc_result(rpc_id, result):
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _rpc_error(rpc_id, code, message):
    """JSON-RPC 2.0 codes: -32700 parse error, -32600 invalid request, -32601 method not found."""
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}
