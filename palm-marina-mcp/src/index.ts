// The actor class must be exported from the entry point: the runtime finds it by the [[actors]] type name.
export { ViewingCalendar } from "./calendar";

import type { Env } from "./env";
import { TOOL_NAMES } from "./tools";
import { adminRoute } from "./admin";
import { authFailureReason } from "./auth";
import { handleMcp } from "./mcp";

export default { fetch: handleRequest };

export async function handleRequest(req: Request, env: Env): Promise<Response> {
	const path = new URL(req.url).pathname;
	const method = req.method;

	if (path === "/health/liveness" || path === "/health/readiness") {
		return new Response("ok");
	}
	if (path === "/health" && method === "GET") {
		return json(200, { status: "ok", tools: TOOL_NAMES.length });
	}

	const admin = adminRoute(path, method);
	if (!admin && path !== "/mcp") {
		return json(404, { error: "not found" });
	}
	if (!admin && method !== "POST") {
		return json(405, { error: "use POST for MCP JSON-RPC" });
	}

	const log: Record<string, unknown> = admin ? { route: path.slice(1) } : {};
	try {
		const authFailure = authFailureReason(req);
		if (authFailure) {
			log.outcome = "unauthorized";
			log.auth_failure = authFailure;
			log.header_names = [...req.headers.keys()].sort(); // names only, never values
			return json(401, { error: "unauthorized" });
		}

		const [status, body] = admin ? await admin(env, log) : await handleMcp(await req.text(), env, log);
		return json(status, body);
	} catch (e) {
		log.outcome = "exception";
		log.error = String(e);
		return json(500, { error: "internal server error" });
	} finally {
		console.log(JSON.stringify(log));
	}
}

function json(status: number, data: object | null): Response {
	if (data === null) {
		return new Response(null, { status });
	}

	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}
