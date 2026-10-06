import type { Listing } from "./listings";

export function areas(listings: Listing[]): string[] {
	return [...new Set(listings.map((l) => l.area))].sort();
}

export function filterListings(
	listings: Listing[],
	purpose?: string,
	area?: string,
	bedrooms?: number,
	budget?: number
): Listing[] {
	const canonical = area?.trim();
	return listings.filter(
		(listing) =>
			(!purpose || listing.purpose === purpose) &&
			(!canonical || listing.area.toLowerCase() === canonical.toLowerCase()) &&
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

export function formatAmount(amount: number): string {
	if (amount >= 1_000_000) {
		return `${trimfloat(amount / 1_000_000)} million`;
	}
	if (amount >= 1_000) {
		return `${trimfloat(amount / 1_000)} thousand`;
	}
	return String(amount);
}

function trimfloat(n: number): string {
	return String(Number(n.toFixed(4)));
}

function describe(listing: Listing): string {
	const rooms = listing.bedrooms === 0 ? "studio" : `${listing.bedrooms} bedroom`;
	const amount = formatAmount(listing.price_aed);
	const price = listing.purpose === "buy" ? `priced at ${amount} dirhams` : `rented at ${amount} dirhams per year`;
	const features = listing.features.slice(0, 3).join(", ");
	return (
		`a ${rooms} ${listing.type} in ${listing.area}, ${listing.size_sqft} square feet, ${price}. ` +
		`It has ${features}. Ref ${listing.reference}.`
	);
}
