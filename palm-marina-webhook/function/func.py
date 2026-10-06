"""Palm & Marina Realty dynamic-variables webhook on Telnyx Edge Compute.

At the start of each call Telnyx POSTs an assistant.initialization event here.
We answer with dynamic variables so the AI concierge knows who is calling, whether
they are returning, what country they are in, and the current time both for them
and in Dubai.

Designed to never fail a call: any error returns safe new-caller defaults within
the webhook timeout (default 1.5s). Every call produces one structured JSON log
line with the masked caller number, channel, whether returning, and the outcome.
Status and latency come from the platform's invocation logs, so they are not here.
"""

import json
import logging

from .utils import find_caller, format_time, lookup_country, mask_number

logger = logging.getLogger("palm-marina-webhook")
logger.setLevel(logging.INFO)


def new():
    """new is the only method that must be implemented by a Function."""
    return Function()


class Function:
    def __init__(self):
        """Optional initialization. See start() for the startup hook."""

    async def handle(self, scope, receive, send):
        """Serve the dynamic-variables webhook on POST /, plus GET /health.

        Async because the ASGI protocol requires async send/receive.
        """
        if scope.get("type") != "http":
            await self._respond(send, 400, {"error": "not http"})
            return

        method = scope.get("method", "GET")
        path = scope.get("path", "/") or "/"

        if path == "/health" and method == "GET":
            await self._respond(send, 200, {"status": "ok"})
            return
        if path != "/":
            await self._respond(send, 404, {"error": "not found"})
            return
        if method != "POST":
            await self._respond(send, 405, {"error": "use POST"})
            return

        # Fail-safe defaults; outcome "exception" is overwritten on the happy path.
        log = {
            "caller_masked": "",
            "channel": "unknown",
            "is_returning": False,
            "outcome": "exception",
        }
        try:
            body = await self._read_body(receive)
            status, payload = self._handle_webhook(body, log)
            await self._respond(send, status, payload)
        except Exception as exc:
            logger.exception("unhandled error in handle")
            log["error"] = str(exc)
            await self._respond(send, 200, _safe_response())
        finally:
            if log["outcome"] in ("exception", "bad_body"):
                logger.error(json.dumps(log))
            else:
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

    def _handle_webhook(self, body, log):
        """Resolve dynamic variables for one assistant.initialization event.

        Returns (http_status, response_body). Never raises: a malformed or
        missing payload yields safe new-caller defaults so the call proceeds.
        """
        payload = self._extract_payload(body, log)
        if payload is None:
            return 200, _safe_response()

        caller_number = str(payload.get("telnyx_end_user_target") or "")
        log["caller_masked"] = mask_number(caller_number)
        log["channel"] = payload.get("telnyx_conversation_channel") or "unknown"
        # The same id arrives with every MCP tool call, so it ties this call's logs together across both functions.
        if payload.get("telnyx_conversation_id"):
            log["conversation_id"] = payload["telnyx_conversation_id"]

        response = _safe_response()
        dv = response["dynamic_variables"]
        dv["dubai_time"] = format_time("Asia/Dubai")
        country, timezone = lookup_country(caller_number)
        if country:
            dv["caller_country"] = country
            dv["caller_local_time"] = format_time(timezone)

        caller = find_caller(caller_number)
        if caller is None:
            log["outcome"] = "new_caller"
            return 200, response

        log["is_returning"] = True
        log["outcome"] = "returning_caller"
        dv["caller_name"] = caller["name"]
        dv["is_returning_caller"] = "true"
        dv["last_time_note"] = caller.get("last_time_note", "")
        return 200, response

    def _extract_payload(self, body, log):
        """Parse the Telnyx event body and return its payload dict, or None.

        Sets log['outcome'] = 'bad_body' when the request cannot be understood.
        """
        try:
            msg = json.loads(body) if body else None
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            msg = None
        data = msg.get("data") if isinstance(msg, dict) else None
        payload = data.get("payload") if isinstance(data, dict) else None
        if not isinstance(payload, dict):
            log["outcome"] = "bad_body"
            return None
        return payload

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
        payload = json.dumps(data).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [[b"content-type", b"application/json"]],
            }
        )
        await send({"type": "http.response.body", "body": payload})


def _safe_response():
    """Safe dynamic variables for a new/unknown caller.

    Used on any failure so the call always proceeds as a new caller.
    """
    return {
        "dynamic_variables": {
            "caller_name": "",
            "is_returning_caller": "false",
            "caller_country": "",
            "caller_local_time": "",
            "dubai_time": "",
            "last_time_note": "",
        }
    }
