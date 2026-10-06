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

export function findListing(ref: string, listings: Listing[]): Listing | undefined {
	return listings.find((l) => l.reference === ref);
}
