/**
 * Each lead gets its own KV key, never one shared value, so two leads saved at the same moment
 * can't overwrite each other. In a real deployment leads would go into the brokerage's CRM.
 */

import type { Env } from "../env";
import type { ToolResult } from ".";

export const LEADS_PREFIX = "lead/";

export const recordSellerLeadDefinition = {
	name: "record_seller_lead",
	description:
		"Record a seller lead: a caller who wants to sell a property. " +
		"Only call this after you have read the property details (area, type, bedrooms, asking price) back to the caller and the caller confirmed they are correct. " +
		"Returns the lead id. Never read the lead id back unless asked.",
	inputSchema: {
		type: "object",
		properties: {
			area: {
				type: "string",
				description: "Where the property is, e.g. 'Dubai Marina'.",
			},
			property_type: {
				type: "string",
				description: "Property type, e.g. 'Apartment', 'Villa'.",
			},
			bedrooms: {
				type: "integer",
				description: "Number of bedrooms. Use 0 for a studio.",
			},
			asking_price: {
				type: "number",
				description: "The price the seller wants, in UAE dirhams.",
			},
			caller_name: {
				type: "string",
				description: "The caller's name, from the dynamic variable {{caller_name}}. Empty for new callers.",
			},
		},
		required: ["area", "property_type", "bedrooms", "asking_price", "caller_name"],
	},
};

export async function recordSellerLead(args: Record<string, unknown>, env: Env): Promise<ToolResult> {
	const area = args.area as string | undefined;
	const propertyType = args.property_type as string | undefined;
	const callerName = (args.caller_name as string | undefined) ?? "";

	if (!area || typeof area !== "string" || !area.trim()) {
		return { isError: true, text: "area is required" };
	}
	if (!propertyType || typeof propertyType !== "string" || !propertyType.trim()) {
		return { isError: true, text: "property_type is required" };
	}

	if (args.bedrooms === undefined || args.bedrooms === null) {
		return { isError: true, text: "bedrooms is required" };
	}
	const bedrooms = Number(args.bedrooms);
	if (!Number.isInteger(bedrooms) || bedrooms < 0) {
		return {
			isError: true,
			text: `bedrooms must be a non-negative integer, got ${JSON.stringify(args.bedrooms)}`,
		};
	}

	if (args.asking_price === undefined || args.asking_price === null) {
		return { isError: true, text: "asking_price is required" };
	}
	const askingPrice = Number(args.asking_price);
	if (isNaN(askingPrice) || askingPrice <= 0) {
		return {
			isError: true,
			text: `asking_price must be a number greater than 0, got ${JSON.stringify(args.asking_price)}`,
		};
	}

	const lead = {
		area: area.trim(),
		property_type: propertyType.trim(),
		bedrooms,
		asking_price: askingPrice,
		caller_name: callerName,
		recorded_at: new Date().toISOString(),
	};
	const id = `SL-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	await env.CACHE.put(`${LEADS_PREFIX}${id}`, JSON.stringify(lead));
	return { isError: false, text: `Seller lead recorded. Lead id ${id}.`, outcome: "recorded" };
}
