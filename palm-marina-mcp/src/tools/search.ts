import { areas, filterListings, formatForVoice, type Listing } from "../listings";
import type { ToolResult } from ".";

export function searchListingsDefinition(listings: Listing[]) {
	return {
		name: "search_listings",
		description:
			"Search available properties for sale or rent in Dubai. " +
			"Returns how many properties match and describes up to 3 in a short, voice-friendly summary. " +
			"All amounts are in UAE dirhams; for rentals the price is the annual rent. " +
			"Each result ends with 'Ref PMR-xxx'. This reference is for the booking tools only — never read it aloud to the caller.",
		inputSchema: {
			type: "object",
			properties: {
				purpose: {
					type: "string",
					enum: ["buy", "rent"],
					description: "Whether the caller wants to buy or to rent. Omit to search both.",
				},
				area: {
					type: "string",
					enum: areas(listings),
					description:
						"Dubai area. Map what the caller says to one of these, " +
						"e.g. 'JBR' -> 'Jumeirah Beach Residence', 'the Palm' -> 'Palm Jumeirah'. " +
						"If it could be several areas, ask the caller first.",
				},
				bedrooms: {
					type: "integer",
					description: "Exact number of bedrooms. Use 0 for a studio.",
				},
				budget: {
					type: "number",
					description:
						"Maximum price in UAE dirhams. For rentals this is the maximum annual rent. " +
						"Properties at or below this price are returned.",
				},
			},
		},
	};
}

export function searchListings(args: Record<string, unknown>, listings: Listing[]): ToolResult {
	const purpose = args.purpose as string | undefined;
	if (purpose && purpose !== "buy" && purpose !== "rent") {
		return { isError: true, text: `purpose must be 'buy' or 'rent', got ${JSON.stringify(purpose)}` };
	}

	// The enum asks the model for a valid area; this check makes sure, and lists the valid ones so it can retry.
	const validAreas = areas(listings);
	const area = args.area as string | undefined;
	if (area && (typeof area !== "string" || !validAreas.some((a) => a.toLowerCase() === area.toLowerCase().trim()))) {
		return { isError: true, text: `Unknown area ${JSON.stringify(area)}. Valid areas: ${validAreas.join(", ")}` };
	}

	let bedrooms: number | undefined = undefined;
	if (args.bedrooms !== undefined && args.bedrooms !== null) {
		bedrooms = Number(args.bedrooms);
		if (!Number.isInteger(bedrooms) || bedrooms < 0) {
			return {
				isError: true,
				text: `bedrooms must be a non-negative integer, got ${JSON.stringify(args.bedrooms)}`,
			};
		}
	}

	let budget: number | undefined = undefined;
	if (args.budget !== undefined && args.budget !== null) {
		budget = Number(args.budget);
		if (isNaN(budget) || budget <= 0) {
			return {
				isError: true,
				text: `budget must be a number greater than 0, got ${JSON.stringify(args.budget)}`,
			};
		}
	}

	const matches = filterListings(listings, purpose, area, bedrooms, budget);
	return { isError: false, text: formatForVoice(matches), count: matches.length };
}
