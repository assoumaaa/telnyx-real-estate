import type { Booking } from "./calendar";
import type { Env } from "./env";
import { agents, getListings, LISTINGS_KV_KEY } from "./listings";
import { LEADS_PREFIX } from "./tools/leads";
import { actorNameFor } from "./tools/viewings";

type AdminHandler = (env: Env, log: Record<string, unknown>) => Promise<[number, object]>;

export function adminRoute(path: string, method: string): AdminHandler | undefined {
	if (path === "/admin/cache/clear" && method === "POST") {
		return clearListingsCache;
	}
	if (path === "/admin/leads" && method === "GET") {
		return listSellerLeads;
	}
	if (path === "/admin/viewings" && method === "GET") {
		return listViewings;
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

/** The CLI only shows that each calendar exists, not what is in it, so each agent's actor lists its own bookings. */
async function listViewings(env: Env, log: Record<string, unknown>): Promise<[number, object]> {
	const loaded = await getListings(env);
	if (!loaded.ok) {
		log.outcome = "listings_unavailable";
		log.error = loaded.error;
		return [503, { error: loaded.error }];
	}

	const viewings: Record<string, Booking[]> = {};
	for (const agent of agents(loaded.listings)) {
		viewings[agent] = await env.CALENDAR.idFromName(actorNameFor(agent)).listBookings();
	}
	log.outcome = "ok";
	log.count = Object.values(viewings).flat().length;
	return [200, { viewings }];
}
