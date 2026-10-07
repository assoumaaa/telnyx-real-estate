/**
 * A rough price range for a seller, from the price per square foot of our own for-sale listings of the same type in
 * the same area. Deliberately simple and always framed as an estimate; an agent gives the real valuation after a visit.
 */

import { areas, formatAmount, type Listing } from "../listings";
import type { ToolResult } from ".";

export function estimateValueDefinition(listings: Listing[]) {
	return {
		name: "estimate_value",
		description:
			"Give a seller a rough price range for their property, based on what similar properties in the same area are listed for. " +
			"Always tell the caller it is a rough estimate, not a valuation, and that an agent confirms it after a visit.",
		inputSchema: {
			type: "object",
			properties: {
				area: {
					type: "string",
					enum: [...areas(listings), "Other"],
					description:
						"Dubai area of the caller's property. Map what the caller says to one of these, e.g. 'Dubai Hills' -> " +
						"'Dubai Hills Estate', 'JBR' -> 'Jumeirah Beach Residence'. Use 'Other' for any area not in the list.",
				},
				property_type: {
					type: "string",
					enum: ["Apartment", "Villa"],
					description: "Apartment or Villa. A flat or studio is an Apartment.",
				},
				size_sqft: {
					type: "number",
					description: "Size of the property in square feet.",
				},
			},
			required: ["area", "property_type", "size_sqft"],
		},
	};
}

export function estimateValue(args: Record<string, unknown>, listings: Listing[]): ToolResult {
	const area = typeof args.area === "string" ? args.area.trim() : "";
	const type = typeof args.property_type === "string" ? args.property_type.trim() : "";

	if (!area) {
		return { isError: true, text: "area is required" };
	}

	if (!type) {
		return { isError: true, text: "property_type is required" };
	}

	const size = Number(args.size_sqft);
	if (!Number.isFinite(size) || size <= 0) {
		return {
			isError: true,
			text: `size_sqft must be a number greater than 0, got ${JSON.stringify(args.size_sqft)}`,
		};
	}

	const comparables = listings.filter((l) => l.purpose === "buy" && l.area === area && l.type === type);
	if (comparables.length === 0) {
		return {
			isError: false,
			text:
				`We don't have a similar ${type.toLowerCase()} for sale in ${area === "Other" ? "that area" : area} to compare with, ` +
				"so I can't estimate it over the phone. " +
				"Would you like me to put you through to one of our agents, who can value it properly?",
			outcome: "no_comparables",
			count: 0,
		};
	}

	const pricePerSqft = comparables.reduce((sum, l) => sum + l.price_aed / l.size_sqft, 0) / comparables.length;
	const estimate = size * pricePerSqft;
	const low = Math.round((estimate * 0.9) / 50_000) * 50_000;
	const high = Math.round((estimate * 1.1) / 50_000) * 50_000;

	return {
		isError: false,
		text:
			`Based on what we list in ${area}, about ${Math.round(pricePerSqft).toLocaleString("en-US")} dirhams per square foot, ` +
			`a ${size} square foot property would be roughly ${formatAmount(low)} to ${formatAmount(high)} dirhams. ` +
			"This is a rough estimate, not a valuation; an agent will confirm it after a visit.",
		outcome: "estimated",
		count: comparables.length,
	};
}
