import type { Env } from "../env";
import { getListings, type Listing } from "../listings";
import {
	recordSellerLead,
	recordSellerLeadDefinition,
	sendListingAgreement,
	sendListingAgreementDefinition,
} from "./leads";
import { searchListings, searchListingsDefinition } from "./search";
import { estimateValue, estimateValueDefinition } from "./valuation";
import { bookViewing, cancelViewing, getAvailableSlots, viewingDefinitions } from "./viewings";

export interface ToolResult {
	isError: boolean;
	text: string;
	count?: number;
	outcome?: string;
	cache?: "hit" | "miss";
}

export const TOOL_NAMES = [
	"search_listings",
	"get_available_slots",
	"book_viewing",
	"cancel_viewing",
	"record_seller_lead",
	"estimate_value",
	"send_listing_agreement",
];

export function isKnownTool(name: string): boolean {
	return TOOL_NAMES.includes(name);
}

/** Built per request because the area lists in search_listings and estimate_value come from the current listings. */
export function buildTools(listings: Listing[]) {
	return [
		searchListingsDefinition(listings),
		...viewingDefinitions,
		recordSellerLeadDefinition,
		estimateValueDefinition(listings),
		sendListingAgreementDefinition,
	];
}

export async function executeTool(name: string, args: Record<string, unknown>, env: Env): Promise<ToolResult> {
	if (name === "record_seller_lead") {
		return recordSellerLead(args, env);
	}

	if (name === "send_listing_agreement") {
		return sendListingAgreement(args);
	}

	const { listings, cache } = await getListings(env);
	return { ...(await listingTool(name, args, env, listings)), cache };
}

async function listingTool(
	name: string,
	args: Record<string, unknown>,
	env: Env,
	listings: Listing[]
): Promise<ToolResult> {
	switch (name) {
		case "search_listings":
			return searchListings(args, listings);
		case "get_available_slots":
			return getAvailableSlots(args, env, listings);
		case "book_viewing":
			return bookViewing(args, env, listings);
		case "cancel_viewing":
			return cancelViewing(args, env, listings);
		case "estimate_value":
			return estimateValue(args, listings);
		default:
			return { isError: true, text: `Unknown tool: ${name}` };
	}
}

/** Arguments that may appear in the log. caller_name is left out on purpose: it is personal data. */
export function allowlistedArgs(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(args).filter(([key]) =>
			[
				"purpose",
				"area",
				"bedrooms",
				"budget",
				"listing_ref",
				"slot_id",
				"date",
				"property_type",
				"asking_price",
				"size_sqft",
			].includes(key)
		)
	);
}
