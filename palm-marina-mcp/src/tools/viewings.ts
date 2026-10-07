/**
 * Each agent has their own ViewingCalendar actor. The platform runs one call at a time per actor,
 * which is what makes double-booking impossible.
 */

import type { Slot } from "../calendar";
import { callerPhone, rememberCaller } from "../callers";
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
			"Book a property viewing with the listing's sales agent, under the caller's name. " +
			"Only call this after you have read the viewing details back to the caller (name, property, day, time) and the caller confirmed yes. " +
			"The slot_id must come from get_available_slots, never free text.",
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
						"The name to book the viewing under. Use the caller's name if you know it; otherwise ask for it first.",
				},
				phone: {
					type: "string",
					description: "The caller's number or caller ID, as given in your instructions.",
				},
			},
			required: ["listing_ref", "slot_id", "caller_name", "phone"],
		},
	},
	{
		name: "cancel_viewing",
		description:
			"Cancel a booked viewing, found by the caller's number and the day of the viewing. " +
			"If nothing is found, the caller may have booked from another phone: ask the name it was booked under and try again with it.",
		inputSchema: {
			type: "object",
			properties: {
				phone: {
					type: "string",
					description: "The caller's number or caller ID, as given in your instructions.",
				},
				date: {
					type: "string",
					description:
						"The day of the viewing as YYYY-MM-DD, e.g. '2026-10-10'. Work it out from today's date if the caller says 'Saturday' or 'tomorrow'.",
				},
				caller_name: {
					type: "string",
					description:
						"Only when nothing was found under the caller's number: the name the viewing was booked under, as the caller said it. Never guess.",
				},
			},
			required: ["phone", "date"],
		},
	},
];

export async function getAvailableSlots(
	args: Record<string, unknown>,
	env: Env,
	listings: Listing[]
): Promise<ToolResult> {
	const ref = typeof args.listing_ref === "string" ? args.listing_ref.trim() : "";
	if (!ref) {
		return { isError: true, text: "listing_ref is required" };
	}

	const listing = findListing(ref, listings);
	if (!listing) {
		return { isError: true, text: `Unknown listing reference: ${ref}` };
	}

	const calendar = env.CALENDAR.idFromName(actorNameFor(listing.agent));
	const { slots } = await calendar.getAvailableSlots();
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
	const ref = typeof args.listing_ref === "string" ? args.listing_ref.trim() : "";
	const slotId = typeof args.slot_id === "string" ? args.slot_id.trim() : "";
	const callerName = typeof args.caller_name === "string" ? args.caller_name.trim() : "";
	const phone = callerPhone(args);

	if (!ref) {
		return { isError: true, text: "listing_ref is required" };
	}

	if (!slotId) {
		return { isError: true, text: "slot_id is required" };
	}

	if (!callerName) {
		return { isError: true, text: "caller_name is required: ask the caller for their name before booking" };
	}

	if (!phone) {
		return {
			isError: true,
			text: "phone is required: use the caller's number from your instructions, not a placeholder",
		};
	}

	const listing = findListing(ref, listings);
	if (!listing) {
		return { isError: true, text: `Unknown listing reference: ${ref}` };
	}

	const calendar = env.CALENDAR.idFromName(actorNameFor(listing.agent));
	const result = await calendar.bookViewing(slotId, callerName, phone, ref);

	if (result.status === "booked") {
		await rememberCaller(env, phone, callerName, {
			last_action: "booked_viewing",
			listing_ref: ref,
			agent: listing.agent,
			viewing: result.slotId,
		});
		return {
			isError: false,
			text: `Booking confirmed under the name ${callerName}: viewing of ${ref} with ${listing.agent} on ${result.slotVoice} Dubai time.`,
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

export async function cancelViewing(args: Record<string, unknown>, env: Env, listings: Listing[]): Promise<ToolResult> {
	const phone = callerPhone(args);
	const date = typeof args.date === "string" ? args.date.trim() : "";
	const callerName = typeof args.caller_name === "string" ? args.caller_name.trim() : "";

	if (!phone) {
		return {
			isError: true,
			text: "phone is required: use the caller's number from your instructions, not a placeholder",
		};
	}

	if (!date) {
		return { isError: true, text: "date is required" };
	}

	for (const agent of agents(listings)) {
		const calendar = env.CALENDAR.idFromName(actorNameFor(agent));
		const result = await calendar.cancelViewing(phone, callerName, date);

		if (result.status === "cancelled") {
			await rememberCaller(env, phone, result.callerName, {
				last_action: "cancelled_viewing",
				viewing: result.slotId,
			});
			return {
				isError: false,
				text: `The viewing on ${result.slotVoice} has been cancelled.`,
				outcome: "cancelled",
			};
		}
	}

	return {
		isError: false,
		text: callerName
			? `I couldn't find a viewing under the name ${callerName} on ${date}. Check the name and the day with the caller.`
			: `I couldn't find a viewing from this caller's number on ${date}. Check the day, and if they booked from another phone, ask the name it was booked under and try again with it.`,
		outcome: "not_found",
	};
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
