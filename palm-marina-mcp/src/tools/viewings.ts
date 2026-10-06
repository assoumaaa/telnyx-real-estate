/**
 * Each agent has their own ViewingCalendar actor. The platform runs one call at a time per actor,
 * which is what makes double-booking impossible.
 */

import type { Slot } from "../calendar";
import type { Env } from "../env";
import { agents, findListing, type Listing } from "../listings";
import type { ToolResult } from ".";

export const viewingDefinitions = [
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
					description: "The caller's name, from the dynamic variable {{caller_name}}. Empty for new callers.",
				},
			},
			required: ["listing_ref", "slot_id", "caller_name"],
		},
	},
	{
		name: "cancel_viewing",
		description: "Cancel a booked viewing using its booking id. Returns whether the cancellation succeeded.",
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
];

export async function getAvailableSlots(
	args: Record<string, unknown>,
	env: Env,
	listings: Listing[]
): Promise<ToolResult> {
	const ref = args.listing_ref as string | undefined;
	if (!ref || typeof ref !== "string") {
		return { isError: true, text: "listing_ref is required" };
	}
	const listing = findListing(ref, listings);
	if (!listing) {
		return { isError: true, text: `Unknown listing reference: ${ref}` };
	}

	const calendar = env.CALENDAR.idFromName(actorNameFor(listing.agent));
	const { slots } = await calendar.getAvailableSlots(4);
	if (slots.length === 0) {
		return { isError: false, text: `There are no free viewing times for ${ref} in the next 7 days.` };
	}
	const parts = slots.map((s) => `${s.voice} (id: ${s.id})`);
	return {
		isError: false,
		text: `Here are the next free viewing times with ${listing.agent}: ${parts.join(", ")}. Ask the caller which one works.`,
	};
}

export async function bookViewing(args: Record<string, unknown>, env: Env, listings: Listing[]): Promise<ToolResult> {
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

	const calendar = env.CALENDAR.idFromName(actorNameFor(listing.agent));
	const result = await calendar.bookViewing(slotId, callerName, ref);

	if (result.status === "booked") {
		return {
			isError: false,
			text: `Booking confirmed. ID ${result.bookingId}. Viewing with ${listing.agent} on ${result.slotVoice} Dubai time for ${ref}.`,
			outcome: "booked",
		};
	}
	if (result.status === "slot_taken") {
		return {
			isError: false,
			text: `That time was just taken. ${formatSlots(result.nextSlots)}. Ask the caller which one works.`,
			outcome: "slot_taken",
		};
	}
	return {
		isError: true,
		text: `That is not a valid slot id. Call get_available_slots first to get a valid one. ${formatSlots(result.nextSlots)}`,
	};
}

/** The booking id doesn't say which agent it belongs to, so ask each agent's calendar. */
export async function cancelViewing(args: Record<string, unknown>, env: Env, listings: Listing[]): Promise<ToolResult> {
	const bookingId = args.booking_id as string | undefined;
	if (!bookingId || typeof bookingId !== "string") {
		return { isError: true, text: "booking_id is required" };
	}

	for (const agent of agents(listings)) {
		const calendar = env.CALENDAR.idFromName(actorNameFor(agent));
		const result = await calendar.cancelViewing(bookingId);
		if (result.status === "cancelled") {
			return { isError: false, text: `Viewing ${result.bookingId} has been cancelled.`, outcome: "cancelled" };
		}
	}
	return { isError: true, text: `I couldn't find a booking with ID ${bookingId}.`, outcome: "not_found" };
}

/**
 * Actor instance name for an agent, e.g. "Layla Al Mansoori" -> "agent-layla-al-mansoori".
 * Telnyx's examples keep actor names to letters, digits, dots and dashes (Dapr-safe), so no spaces.
 */
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
