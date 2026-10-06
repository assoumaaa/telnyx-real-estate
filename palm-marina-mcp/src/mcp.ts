import type { Env } from "./env";
import type { Listing } from "./listings";
import { getListings, LISTINGS_KV_KEY } from "./listings-store";
import {
	allowlistedArgs,
	buildTools,
	executeTool,
	isKnownTool,
	LEADS_PREFIX,
	TOOL_NAMES,
	type ToolResult,
} from "./tools";

export async function handleRequest(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	const method = req.method;

	// Platform probes, answered before anything else, as in the Telnyx actor examples.
	if (path === "/health/liveness" || path === "/health/readiness") {
		return new Response("ok");
	}
	if (path === "/health" && method === "GET") {
		return json(200, { status: "ok", tools: TOOL_NAMES.length });
	}

	if (path === "/admin/cache/clear" && method === "POST") {
		return handleAdminCacheClear(req, env);
	}
	if (path === "/admin/leads" && method === "GET") {
		return handleAdminLeads(req, env);
	}

	if (path !== "/mcp") {
		return json(404, { error: "not found" });
	}
	if (method !== "POST") {
		return json(405, { error: "use POST for MCP JSON-RPC" });
	}

	const log: Record<string, unknown> = {};
	try {
		const authFailure = authFailureReason(req, env);
		if (authFailure) {
			log.outcome = "unauthorized";
			log.auth_failure = authFailure;
			log.header_names = [...req.headers.keys()].sort();
			return json(401, { error: "unauthorized" });
		}

		const body = await req.text();
		const [status, payload] = await handleRpc(body, log, env);
		return json(status, payload);
	} catch (e) {
		log.outcome = "exception";
		log.error = String(e);
		return json(500, { error: "internal server error" });
	} finally {
		console.log(JSON.stringify(log));
	}
}

async function handleRpc(body: string, log: Record<string, unknown>, env: Env): Promise<[number, object | null]> {
	let msg: unknown;
	try {
		msg = JSON.parse(body);
	} catch {
		log.outcome = "invalid_json";
		log.error = "invalid json in request body";
		return [400, rpcError(null, -32700, "Parse error")];
	}

	if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
		log.outcome = "invalid_request";
		log.error = "body is not a JSON-RPC object";
		return [400, rpcError(null, -32600, "Invalid request: expected a single JSON-RPC object")];
	}

	const obj = msg as Record<string, unknown>;
	const rpcMethod = obj.method as string | undefined;
	const rpcId = obj.id;
	const params = typeof obj.params === "object" && obj.params !== null ? (obj.params as Record<string, unknown>) : {};
	log.rpc_method = rpcMethod;

	if (rpcId === undefined) {
		log.outcome = "accepted";
		return [202, null];
	}

	if (rpcMethod === "initialize") {
		log.outcome = "ok";
		return [
			200,
			rpcResult(rpcId, {
				protocolVersion: (params.protocolVersion as string) ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "palm-marina-mcp", version: "0.1.0" },
			}),
		];
	}

	if (rpcMethod === "ping") {
		log.outcome = "ok";
		return [200, rpcResult(rpcId, {})];
	}

	if (rpcMethod === "tools/list") {
		const lr = await getListings(env);
		if (!lr.ok) {
			log.outcome = "listings_unavailable";
			log.error = lr.error;
			return [500, rpcError(rpcId, -32603, "listings unavailable")];
		}
		log.cache = lr.cache;
		log.outcome = "ok";
		return [200, rpcResult(rpcId, { tools: buildTools(lr.listings) })];
	}

	if (rpcMethod !== "tools/call") {
		log.outcome = "unknown_method";
		log.error = `method not found: ${rpcMethod}`;
		return [200, rpcError(rpcId, -32601, `Method not found: ${rpcMethod}`)];
	}

	return handleToolCall(rpcId, params, log, env);
}

async function handleToolCall(
	rpcId: unknown,
	params: Record<string, unknown>,
	log: Record<string, unknown>,
	env: Env
): Promise<[number, object]> {
	const toolName = (params.name as string) ?? "";
	const toolArgs =
		typeof params.arguments === "object" && params.arguments !== null
			? (params.arguments as Record<string, unknown>)
			: {};
	log.tool = toolName;
	log.arguments = allowlistedArgs(toolArgs);

	if (!isKnownTool(toolName)) {
		log.outcome = "unknown_tool";
		log.error = `Unknown tool: ${toolName}`;
		return [200, rpcResult(rpcId, toolContent(`Unknown tool: ${toolName}`, true))];
	}

	let listings: Listing[] = [];
	if (toolName !== "record_seller_lead") {
		const lr = await getListings(env);
		if (!lr.ok) {
			log.outcome = "listings_unavailable";
			log.error = lr.error;
			return [
				200,
				rpcResult(
					rpcId,
					toolContent(
						"I can't look up property information right now — the listing data is unavailable. Please try again in a moment.",
						true
					)
				),
			];
		}
		log.cache = lr.cache;
		listings = lr.listings;
	}

	const result: ToolResult = await executeTool(toolName, toolArgs, env, listings);

	if (result.isError) {
		log.outcome = result.outcome ?? "bad_args";
		log.error = result.text;
		return [200, rpcResult(rpcId, toolContent(result.text, true))];
	}

	log.outcome = result.outcome ?? (result.count === 0 ? "no_matches" : "ok");
	if (result.count !== undefined) {
		log.count = result.count;
	}
	return [200, rpcResult(rpcId, toolContent(result.text, false))];
}

async function handleAdminCacheClear(req: Request, env: Env): Promise<Response> {
	const log: Record<string, unknown> = { route: "admin/cache/clear" };
	try {
		const failure = authFailureReason(req, env);
		if (failure) {
			log.outcome = "unauthorized";
			log.auth_failure = failure;
			log.header_names = [...req.headers.keys()].sort();
			return json(401, { error: "unauthorized" });
		}
		await env.CACHE.delete(LISTINGS_KV_KEY);
		log.outcome = "ok";
		return json(200, { status: "ok", cleared: LISTINGS_KV_KEY });
	} catch (e) {
		log.outcome = "exception";
		log.error = String(e);
		return json(500, { error: "internal server error" });
	} finally {
		console.log(JSON.stringify(log));
	}
}

async function handleAdminLeads(req: Request, env: Env): Promise<Response> {
	const log: Record<string, unknown> = { route: "admin/leads" };
	try {
		const failure = authFailureReason(req, env);
		if (failure) {
			log.outcome = "unauthorized";
			log.auth_failure = failure;
			log.header_names = [...req.headers.keys()].sort();
			return json(401, { error: "unauthorized" });
		}
		const page = await env.CACHE.list({ prefix: LEADS_PREFIX });
		const leads = page.keys.map((k) => k.name);
		log.outcome = "ok";
		log.count = leads.length;
		return json(200, { leads });
	} catch (e) {
		log.outcome = "exception";
		log.error = String(e);
		return json(500, { error: "internal server error" });
	} finally {
		console.log(JSON.stringify(log));
	}
}

function authFailureReason(req: Request, env: Env): string | null {
	const expected = env.MCP_TOKEN ?? "";
	if (!expected) {
		return "MCP_TOKEN secret not set";
	}

	const header = req.headers.get("Authorization");
	if (header === null) {
		return "no authorization header";
	}

	const spaceIdx = header.indexOf(" ");
	const scheme = spaceIdx >= 0 ? header.slice(0, spaceIdx) : header;
	if (scheme.toLowerCase() !== "bearer") {
		return `not a Bearer header (${header.length} chars, ${spaceIdx >= 0 ? "has" : "no"} space)`;
	}

	const token = spaceIdx >= 0 ? header.slice(spaceIdx + 1) : "";
	if (!timingSafeEqual(token, expected)) {
		return `token mismatch (sent ${token.length} chars, expected ${expected.length} chars)`;
	}
	return null;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
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

function rpcResult(id: unknown, result: unknown): object {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): object {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolContent(text: string, isError: boolean): object {
	return { content: [{ type: "text", text }], isError };
}
