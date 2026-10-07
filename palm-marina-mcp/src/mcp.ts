import { allowlistedArgs, buildTools, executeTool, isKnownTool } from "./tools";

import type { Env } from "./env";
import { getListings } from "./listings";

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
	const rpcId = obj.id;
	const rpcMethod = typeof obj.method === "string" ? obj.method : "";
	const params = (obj.params ?? {}) as Record<string, unknown>;

	log.rpc_method = rpcMethod;

	const meta = params._meta as { telnyx_conversation_id?: string } | undefined;
	if (meta?.telnyx_conversation_id) {
		log.conversation_id = meta.telnyx_conversation_id;
	}

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
				protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
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
		const { listings, cache } = await getListings(env);
		log.cache = cache;
		log.outcome = "ok";
		return [200, rpcResult(rpcId, { tools: buildTools(listings) })];
	}

	if (rpcMethod !== "tools/call") {
		log.outcome = "unknown_method";
		log.error = `method not found: ${rpcMethod}`;
		return [200, rpcError(rpcId, -32601, `Method not found: ${rpcMethod}`)];
	}

	// A crash answered as HTTP 500 counts as no answer for Telnyx, which waits for its tool timeout and retries while
	// the caller hears nothing. Answering it as a tool error lets the model offer a real agent straight away.
	try {
		return await callTool(rpcId, params, env, log);
	} catch (e) {
		log.outcome = "exception";
		// Lead keys contain the caller's number and storage errors repeat the key, so long digit runs are masked.
		log.error = String(e).replace(/\d{7,}/g, "[number]");
		return toolFailed(rpcId);
	}
}

async function callTool(
	rpcId: unknown,
	params: Record<string, unknown>,
	env: Env,
	log: Record<string, unknown>
): Promise<[number, object]> {
	const toolName = typeof params.name === "string" ? params.name : "";
	const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

	log.tool = toolName;
	log.arguments = allowlistedArgs(toolArgs);

	if (!isKnownTool(toolName)) {
		log.outcome = "unknown_tool";
		log.error = `Unknown tool: ${toolName}`;
		return [200, rpcResult(rpcId, toolContent(`Unknown tool: ${toolName}`, true))];
	}

	const result = await executeTool(toolName, toolArgs, env);

	log.cache = result.cache;
	if (result.isError) {
		log.outcome = result.outcome ?? "bad_args";
		log.error = result.text;
		return [200, rpcResult(rpcId, toolContent(result.text, true))];
	}
	log.outcome = result.outcome ?? (result.count === 0 ? "no_matches" : "ok");
	log.count = result.count;

	return [200, rpcResult(rpcId, toolContent(result.text, false))];
}

/** What the model hears when a tool crashed, so it offers the caller a person instead of retrying. */
function toolFailed(rpcId: unknown): [number, object] {
	const text =
		"Something went wrong on our side and this didn't go through. " +
		"Don't try again: apologise, and offer to put the caller through to one of our agents.";
	return [200, rpcResult(rpcId, toolContent(text, true))];
}

function rpcResult(id: unknown, result: unknown): object {
	return { jsonrpc: "2.0", id, result };
}

/** JSON-RPC 2.0 codes: -32700 parse error, -32600 invalid request, -32601 method not found. */
function rpcError(id: unknown, code: number, message: string): object {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolContent(text: string, isError: boolean): object {
	return { content: [{ type: "text", text }], isError };
}
