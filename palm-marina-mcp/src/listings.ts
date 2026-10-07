/**
 * The source of truth is the brokerage's "CRM export": listings.json in a Cloud Storage bucket.
 * KV only keeps a one-hour copy so most searches never touch the bucket; it can be cleared any time
 * and is rebuilt from the bucket, so it is a cache, not a database.
 */

import type { Env } from "./env";

export interface Listing {
	purpose: "buy" | "rent";
	area: string;
	type: string;
	bedrooms: number;
	bathrooms: number;
	size_sqft: number;
	price_aed: number;
	agent: string;
	agent_phone: string;
	reference: string;
	features: string[];
}

const LISTINGS_KV_KEY = "listings/v1";

/**
 * The listings from the KV cache, or from the bucket on a miss. Throws when they can't be read, so a failure is never
 * hidden behind stale or empty data: a tool call then answers with a tool error, and tools/list with a 500.
 */
export async function getListings(env: Env): Promise<{ listings: Listing[]; cache: "hit" | "miss" }> {
	const cached = await env.KV.get<Listing[]>(LISTINGS_KV_KEY, { type: "json" });
	if (cached !== null) {
		return { listings: cached, cache: "hit" };
	}

	const obj = await env.FILES.get("listings.json");
	if (obj === null) {
		throw new Error('listings.json not found in the bucket (key "listings.json")');
	}

	if (!("body" in obj)) {
		throw new Error('listings.json exists but has no body (key "listings.json")');
	}

	const parsed = await obj.json();
	if (!Array.isArray(parsed)) {
		throw new Error("listings.json is not a JSON array");
	}

	const listings = parsed as Listing[];
	await env.KV.put(LISTINGS_KV_KEY, JSON.stringify(listings), { expirationTtl: 3600 });
	return { listings, cache: "miss" };
}

export function findListing(ref: string, listings: Listing[]): Listing | undefined {
	return listings.find((l) => l.reference === ref);
}

/** Valid area names, built from the data, so a new area in listings.json is searchable straight away. */
export function areas(listings: Listing[]): string[] {
	return [...new Set(listings.map((l) => l.area))].sort();
}

export function agents(listings: Listing[]): string[] {
	return [...new Set(listings.map((l) => l.agent))];
}

export function filterListings(
	listings: Listing[],
	purpose?: string,
	area?: string,
	bedrooms?: number,
	budget?: number
): Listing[] {
	return listings.filter(
		(listing) =>
			(!purpose || listing.purpose === purpose) &&
			(!area || listing.area === area) &&
			(bedrooms === undefined || listing.bedrooms === bedrooms) &&
			(budget === undefined || listing.price_aed <= budget)
	);
}

export function formatForVoice(matches: Listing[]): string {
	if (matches.length === 0) {
		return (
			"I'm sorry, I couldn't find any properties matching those criteria. " +
			"Would you like me to widen the search, for example by raising the budget or trying a different area?"
		);
	}

	// More than 3 options is too much to follow on a phone call.
	const shown = matches.slice(0, 3);
	let intro: string;
	if (matches.length === 1) {
		intro = "I found one matching property.";
	} else if (matches.length <= 3) {
		intro = `I found ${matches.length} matching properties.`;
	} else {
		intro = `I found ${matches.length} matching properties. Here are the first ${shown.length}.`;
	}

	const parts = [intro, ...shown.map((l, i) => `Option ${i + 1}: ${describe(l)}`)];
	return parts.join(" ");
}

/** 2550000 -> "2.55 million", 95000 -> "95 thousand". Never rounds the price a caller hears. */
export function formatAmount(amount: number): string {
	if (amount >= 1_000_000) {
		return `${trimFloat(amount / 1_000_000)} million`;
	}

	if (amount >= 1_000) {
		return `${trimFloat(amount / 1_000)} thousand`;
	}

	return String(amount);
}

function trimFloat(n: number): string {
	return String(Number(n.toFixed(4)));
}

function describe(listing: Listing): string {
	const rooms = listing.bedrooms === 0 ? "studio" : `${listing.bedrooms} bedroom`;
	const amount = formatAmount(listing.price_aed);
	const price = listing.purpose === "buy" ? `priced at ${amount} dirhams` : `rented at ${amount} dirhams per year`;
	const features = listing.features.slice(0, 3).join(", ");

	// The reference is for the booking tools; the tool description tells the model never to read it aloud.
	return (
		`a ${rooms} ${listing.type} in ${listing.area}, ${listing.size_sqft} square feet, ${price}. ` +
		`It has ${features}. Ref ${listing.reference}.`
	);
}
