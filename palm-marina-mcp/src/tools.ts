import type { Env } from "./env";
import { findListing, type Listing } from "./listings";
import { agents, type Slot } from "./calendar";
import { areas, filterListings, formatForVoice } from "./utils";

export const LEADS_PREFIX = "lead/";

const LOGGABLE_ARGS = new Set([
	"purpose",
	"area",
	"bedrooms",
	"budget",
	"listing_ref",
	"slot_id",
	"booking_id",
	"property_type",
	"asking_price",
]);

export function allowlistedArgs(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (LOGGABLE_ARGS.has(k)) out[k] = v;
	}
	return out;
}

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
] as const;

const TOOL_NAMES_SET = new Set<string>(TOOL_NAMES);

export function isKnownTool(name: string): boolean {
	return TOOL_NAMES_SET.has(name);
}

export function buildTools(listings: Listing[]) {
	const areaEnum = areas(listings);
	return [
		{
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
						enum: areaEnum,
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
		},
		{
			name: "get_available_slots",
			description:
				"Get the next few free viewing times for a property. " +
				"Returns voice-friendly descriptions and the exact slot ids the model needs for book_viewing. " +
				"Read the voice-friendly times aloud; never read the slot ids aloud.",
			inputSchema: {
				type: "object",
				properties: {
					listing_ref: {
						type: "string",
						description: "The property reference from search_listings, e.g. 'PMR-101'.",
					},
				},
				required: ["listing_ref"],
			},
		},
		{
			name: "book_viewing",
			description:
				"Book a property viewing with the listing's sales agent. " +
				"Only call this after you have read the viewing details back to the caller (property, agent, day, time) and the caller confirmed yes. " +
				"The slot_id must come from get_available_slots, never free text. " +
				"Returns a booking id.",
			inputSchema: {
				type: "object",
				properties: {
					listing_ref: {
						type: "string",
						description: "The property reference, e.g. 'PMR-101'.",
					},
					slot_id: {
						type: "string",
						description: "The exact slot id from get_available_slots, e.g. '2026-10-10T16:00+04:00'.",
					},
					caller_name: {
						type: "string",
						description:
							"The caller's name, from the dynamic variable {{caller_name}}. Empty for new callers.",
					},
				},
				required: ["listing_ref", "slot_id", "caller_name"],
			},
		},
		{
			name: "cancel_viewing",
			description:
				"Cancel a booked viewing using its booking id. " + "Returns whether the cancellation succeeded.",
			inputSchema: {
				type: "object",
				properties: {
					booking_id: {
						type: "string",
						description: "The booking id returned by book_viewing, e.g. 'BK-abc123'.",
					},
				},
				required: ["booking_id"],
			},
		},
		{
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
						description:
							"The caller's name, from the dynamic variable {{caller_name}}. Empty for new callers.",
					},
				},
				required: ["area", "property_type", "bedrooms", "asking_price", "caller_name"],
			},
		},
	];
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	env: Env,
	listings: Listing[]
): Promise<ToolResult> {
	switch (name) {
		case "search_listings":
			return execSearchListings(args, listings);
		case "get_available_slots":
			return await execGetAvailableSlots(args, env, listings);
		case "book_viewing":
			return await execBookViewing(args, env, listings);
		case "cancel_viewing":
			return await execCancelViewing(args, env, listings);
		case "record_seller_lead":
			return await execRecordSellerLead(args, env);
		default:
			return { isError: true, text: `Unknown tool: ${name}` };
	}
}

function execSearchListings(args: Record<string, unknown>, listings: Listing[]): ToolResult {
	const purpose = args.purpose as string | undefined;
	if (purpose && purpose !== "buy" && purpose !== "rent") {
		return { isError: true, text: `purpose must be 'buy' or 'rent', got ${JSON.stringify(purpose)}` };
	}

	const areaEnum = areas(listings);
	const area = args.area as string | undefined;
	if (area && (typeof area !== "string" || !areaEnum.some((a) => a.toLowerCase() === area.toLowerCase().trim()))) {
		return { isError: true, text: `Unknown area ${JSON.stringify(area)}. Valid areas: ${areaEnum.join(", ")}` };
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

function execGetAvailableSlots(args: Record<string, unknown>, env: Env, listings: Listing[]): Promise<ToolResult> {
	const ref = args.listing_ref as string | undefined;
	if (!ref || typeof ref !== "string") {
		return Promise.resolve({ isError: true, text: "listing_ref is required" });
	}
	const listing = findListing(ref, listings);
	if (!listing) {
		return Promise.resolve({ isError: true, text: `Unknown listing reference: ${ref}` });
	}

	return _getSlots(listing.agent, listing.reference, env);
}

async function _getSlots(agent: string, ref: string, env: Env): Promise<ToolResult> {
	const stub = env.CALENDAR.idFromName(actorNameFor(agent));
	const { slots } = await stub.getAvailableSlots(4);
	if (slots.length === 0) {
		return { isError: false, text: `There are no free viewing times for ${ref} in the next 7 days.` };
	}
	const parts = slots.map((s) => `${s.voice} (id: ${s.id})`);
	return {
		isError: false,
		text: `Here are the next free viewing times with ${agent}: ${parts.join(", ")}. Ask the caller which one works.`,
	};
}

async function execBookViewing(args: Record<string, unknown>, env: Env, listings: Listing[]): Promise<ToolResult> {
	const ref = args.listing_ref as string | undefined;
	const slotId = args.slot_id as string | undefined;
	const callerName = (args.caller_name as string | undefined) ?? "";

	if (!ref || typeof ref !== "string") {
		return { isError: true, text: "listing_ref is required" };
	}
	if (!slotId || typeof slotId !== "string") {
		return { isError: true, text: "slot_id is required" };
	}
	const listing = findListing(ref, listings);
	if (!listing) {
		return { isError: true, text: `Unknown listing reference: ${ref}` };
	}

	const stub = env.CALENDAR.idFromName(actorNameFor(listing.agent));
	const result = await stub.bookViewing(slotId, callerName, ref);

	if (result.status === "booked") {
		return {
			isError: false,
			text: `Booking confirmed. ID ${result.bookingId}. Viewing with ${listing.agent} on ${result.slotVoice} Dubai time for ${ref}.`,
			outcome: "booked",
		};
	}
	if (result.status === "slot_taken") {
		const next = formatSlots(result.nextSlots);
		return {
			isError: false,
			text: `That time was just taken. ${next}. Ask the caller which one works.`,
			outcome: "slot_taken",
		};
	}
	const next = formatSlots(result.nextSlots);
	return {
		isError: true,
		text: `That is not a valid slot id. Call get_available_slots first to get a valid one. ${next}`,
	};
}

async function execCancelViewing(args: Record<string, unknown>, env: Env, listings: Listing[]): Promise<ToolResult> {
	const bookingId = args.booking_id as string | undefined;
	if (!bookingId || typeof bookingId !== "string") {
		return { isError: true, text: "booking_id is required" };
	}

	for (const agent of agents(listings)) {
		const stub = env.CALENDAR.idFromName(actorNameFor(agent));
		const result = await stub.cancelViewing(bookingId);
		if (result.status === "cancelled") {
			return { isError: false, text: `Viewing ${result.bookingId} has been cancelled.`, outcome: "cancelled" };
		}
	}
	return { isError: true, text: `I couldn't find a booking with ID ${bookingId}.`, outcome: "not_found" };
}

async function execRecordSellerLead(args: Record<string, unknown>, env: Env): Promise<ToolResult> {
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
	const id = makeLeadId();
	await env.CACHE.put(`${LEADS_PREFIX}${id}`, JSON.stringify(lead));
	return { isError: false, text: `Seller lead recorded. Lead id ${id}.`, outcome: "recorded" };
}

export function actorNameFor(agent: string): string {
	return `agent-${agent.toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`;
}

function formatSlots(slots: Slot[]): string {
	if (slots.length === 0) {
		return "There are no free times available";
	}
	const parts = slots.map((s) => `${s.voice} (id: ${s.id})`);
	return `The next free times are: ${parts.join(", ")}`;
}

function makeLeadId(): string {
	return `SL-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
