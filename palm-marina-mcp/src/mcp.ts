import type { Env } from "./env";
import { getListings, type Listing } from "./listings";
import { allowlistedArgs, buildTools, executeTool, isKnownTool, needsListings } from "./tools";

export async function handleMcp(
	body: string,
	env: Env,
	log: Record<string, unknown>
): Promise<[number, object | null]> {
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

	// Notifications carry no id and get no reply.
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
		const loaded = await getListings(env);
		if (!loaded.ok) {
			log.outcome = "listings_unavailable";
			log.error = loaded.error;
			return [500, rpcError(rpcId, -32603, "listings unavailable")];
		}
		log.cache = loaded.cache;
		log.outcome = "ok";
		return [200, rpcResult(rpcId, { tools: buildTools(loaded.listings) })];
	}

	if (rpcMethod !== "tools/call") {
		log.outcome = "unknown_method";
		log.error = `method not found: ${rpcMethod}`;
		return [200, rpcError(rpcId, -32601, `Method not found: ${rpcMethod}`)];
	}

	return callTool(rpcId, params, env, log);
}

async function callTool(
	rpcId: unknown,
	params: Record<string, unknown>,
	env: Env,
	log: Record<string, unknown>
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
	if (needsListings(toolName)) {
		const loaded = await getListings(env);
		if (!loaded.ok) {
			log.outcome = "listings_unavailable";
			log.error = loaded.error;
			const text =
				"I can't look up property information right now — the listing data is unavailable. Please try again in a moment.";
			return [200, rpcResult(rpcId, toolContent(text, true))];
		}
		log.cache = loaded.cache;
		listings = loaded.listings;
	}

	const result = await executeTool(toolName, toolArgs, env, listings);
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

function rpcResult(id: unknown, result: unknown): object {
	return { jsonrpc: "2.0", id, result };
}

/** JSON-RPC 2.0 codes: -32700 parse error, -32600 invalid request, -32601 method not found, -32603 internal error. */
function rpcError(id: unknown, code: number, message: string): object {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolContent(text: string, isError: boolean): object {
	return { content: [{ type: "text", text }], isError };
}
