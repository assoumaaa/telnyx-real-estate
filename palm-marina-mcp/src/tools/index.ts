import type { Env } from "../env";
import type { Listing } from "../listings";
import { recordSellerLead, recordSellerLeadDefinition } from "./leads";
import { searchListings, searchListingsDefinition } from "./search";
import { bookViewing, cancelViewing, getAvailableSlots, viewingDefinitions } from "./viewings";

export interface ToolResult {
	isError: boolean;
	text: string;
	count?: number;
	outcome?: string;
}

export const TOOL_NAMES = [
	"search_listings",
	"get_available_slots",
	"book_viewing",
	"cancel_viewing",
	"record_seller_lead",
];

export function isKnownTool(name: string): boolean {
	return TOOL_NAMES.includes(name);
}

/** Built per request because the search tool's area list comes from the current listings. */
export function buildTools(listings: Listing[]) {
	return [searchListingsDefinition(listings), ...viewingDefinitions, recordSellerLeadDefinition];
}

export function needsListings(name: string): boolean {
	return name !== "record_seller_lead";
}

export async function executeTool(
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
		case "record_seller_lead":
			return recordSellerLead(args, env);
		default:
			return { isError: true, text: `Unknown tool: ${name}` };
	}
}

/** Arguments that may appear in the log. caller_name is left out on purpose: it is personal data. */
export function allowlistedArgs(args: Record<string, unknown>): Record<string, unknown> {
	const loggable = [
		"purpose",
		"area",
		"bedrooms",
		"budget",
		"listing_ref",
		"slot_id",
		"booking_id",
		"property_type",
		"asking_price",
	];
	return Object.fromEntries(Object.entries(args).filter(([key]) => loggable.includes(key)));
}
