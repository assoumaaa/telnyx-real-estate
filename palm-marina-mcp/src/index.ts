export { ViewingCalendar } from "./calendar";

import type { Env } from "./env";
import { handleRequest } from "./mcp";

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		return handleRequest(req, env);
	},
};
