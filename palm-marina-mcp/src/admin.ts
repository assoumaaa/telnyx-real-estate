import type { Env } from "./env";
import { LISTINGS_KV_KEY } from "./listings";
import { LEADS_PREFIX } from "./tools/leads";

type AdminHandler = (env: Env, log: Record<string, unknown>) => Promise<[number, object]>;

export function adminRoute(path: string, method: string): AdminHandler | undefined {
	if (path === "/admin/cache/clear" && method === "POST") {
		return clearListingsCache;
	}
	if (path === "/admin/leads" && method === "GET") {
		return listSellerLeads;
	}
	return undefined;
}

/** After uploading a new listings.json, so the next search reads it instead of waiting for the cache to expire. */
async function clearListingsCache(env: Env, log: Record<string, unknown>): Promise<[number, object]> {
	await env.CACHE.delete(LISTINGS_KV_KEY);
	log.outcome = "ok";
	return [200, { status: "ok", cleared: LISTINGS_KV_KEY }];
}

async function listSellerLeads(env: Env, log: Record<string, unknown>): Promise<[number, object]> {
	const page = await env.CACHE.list({ prefix: LEADS_PREFIX });
	const leads = page.keys.map((k) => k.name);
	log.outcome = "ok";
	log.count = leads.length;
	return [200, { leads }];
}
