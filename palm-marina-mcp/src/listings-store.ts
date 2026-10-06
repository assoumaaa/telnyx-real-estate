import type { Env } from "./env";
import type { Listing } from "./listings";

export const LISTINGS_KV_KEY = "listings/v1";
const BUCKET_KEY = "listings.json";
const TTL_SECONDS = 3600;

export type ListingsResult = { ok: true; listings: Listing[]; cache: "hit" | "miss" } | { ok: false; error: string };

export async function getListings(env: Env): Promise<ListingsResult> {
	const cached = await env.CACHE.get<Listing[]>(LISTINGS_KV_KEY, { type: "json" });
	if (cached !== null) {
		return { ok: true, listings: cached, cache: "hit" };
	}

	try {
		const obj = await env.FILES.get(BUCKET_KEY);
		if (obj === null) {
			return { ok: false, error: `listings.json not found in the bucket (key "${BUCKET_KEY}")` };
		}
		if (!("body" in obj)) {
			return { ok: false, error: `listings.json exists but has no body (key "${BUCKET_KEY}")` };
		}
		const parsed = await obj.json();
		if (!Array.isArray(parsed)) {
			return { ok: false, error: "listings.json is not a JSON array" };
		}
		const listings = parsed as Listing[];
		await env.CACHE.put(LISTINGS_KV_KEY, JSON.stringify(listings), { expirationTtl: TTL_SECONDS });
		return { ok: true, listings, cache: "miss" };
	} catch (e) {
		return { ok: false, error: `could not read listings from the bucket: ${String(e)}` };
	}
}
