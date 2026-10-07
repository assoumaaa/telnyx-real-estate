import { handleDynamicVariables } from "./dynamic-variables";
import type { Env } from "./env";

export default { fetch: handleRequest };

export async function handleRequest(req: Request, env: Env): Promise<Response> {
	const path = new URL(req.url).pathname;
	if (path === "/health/liveness" || path === "/health/readiness") {
		return new Response("ok");
	}

	if (path === "/health" && req.method === "GET") {
		return Response.json({ status: "ok" });
	}

	// Telnyx POSTs an assistant.initialization event here at the start of every call.
	if (path === "/" && req.method === "POST") {
		return handleDynamicVariables(req, env);
	}

	if (path === "/") {
		return Response.json({ error: "use POST" }, { status: 405 });
	}

	return Response.json({ error: "not found" }, { status: 404 });
}
