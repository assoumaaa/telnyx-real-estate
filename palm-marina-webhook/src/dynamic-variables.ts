/**
 * The dynamic variables webhook. At the start of every call Telnyx POSTs an assistant.initialization event, and we
 * answer with who is calling and what they did last time.
 *
 * Who is calling comes from one KV read: the session summary palm-marina-mcp saves under caller/<number> after a
 * booking, cancel or seller lead. The bookings themselves stay in the agents' calendar actors; this is only for the
 * greeting.
 *
 * It never fails a call: anything that goes wrong returns the new-caller defaults, well inside the assistant's
 * webhook timeout. Every request writes one JSON log line with the masked number, the channel and the outcome.
 */

import type { Env } from "./env";

type InitializationEvent = {
	data?: {
		payload?: {
			telnyx_end_user_target?: string;
			telnyx_conversation_channel?: string;
			telnyx_conversation_id?: string;
		};
	};
};

export async function handleDynamicVariables(req: Request, env: Env): Promise<Response> {
	const log: Record<string, unknown> = {};
	try {
		const event: InitializationEvent | null = await req.json().catch(() => null);
		const payload = event?.data?.payload;

		if (!payload) {
			log.outcome = "bad_body";
			return variablesResponse(newCaller());
		}

		const caller = payload.telnyx_end_user_target ?? "";
		log.caller_masked = maskNumber(caller);
		log.channel = payload.telnyx_conversation_channel;
		log.conversation_id = payload.telnyx_conversation_id;

		const known = await callerVariables(env, caller);
		if (!known) {
			log.outcome = "new_caller";
			return variablesResponse(newCaller());
		}

		log.outcome = "returning_caller";
		return variablesResponse({ ...newCaller(), ...known });
	} catch (e) {
		// A failed KV read lands here too. Storage errors repeat the key, which holds the number, so digits are masked.
		log.outcome = "exception";
		log.error = String(e).replace(/\d{7,}/g, "[number]");
		return variablesResponse(newCaller());
	} finally {
		// stderr for failures, so the platform's logs mark them as errors.
		const line = JSON.stringify(log);
		if (log.outcome === "exception" || log.outcome === "bad_body") {
			console.error(line);
		} else {
			console.log(line);
		}
	}
}

/** The answer for a caller we know nothing about; also what every failure returns. */
function newCaller(): Record<string, string> {
	return {
		caller_name: "",
		is_returning_caller: "false",
		last_time_note: "",
		has_upcoming_viewing: "false",
		last_listing_ref: "",
	};
}

function variablesResponse(variables: Record<string, string>): Response {
	return Response.json({ dynamic_variables: variables });
}

function maskNumber(number: string): string {
	return "*".repeat(Math.max(number.length - 2, 0)) + number.slice(-2);
}

type Remembered = { name: string } & (
	| { last_action: "booked_viewing"; listing_ref: string; agent: string; viewing: string }
	| { last_action: "cancelled_viewing"; viewing: string }
	| { last_action: "seller_lead"; area: string; property_type: string; bedrooms: number }
);

/**
 * One KV read: the session summary palm-marina-mcp keeps under caller/<number>. The sentence is built here on every
 * call rather than stored, so a viewing that has already happened is never called upcoming.
 */
async function callerVariables(env: Env, caller: string): Promise<Record<string, string> | null> {
	const remembered = await env.KV.get<Remembered>(`caller/${kvSafe(caller)}`, { type: "json" });
	if (remembered === null) {
		return null;
	}

	const known = { caller_name: remembered.name, is_returning_caller: "true" };
	if (remembered.last_action === "booked_viewing") {
		if (new Date(remembered.viewing) > new Date()) {
			return {
				...known,
				has_upcoming_viewing: "true",
				last_listing_ref: remembered.listing_ref,
				last_time_note: `You have a viewing with ${remembered.agent} on ${spokenTime(remembered.viewing)} Dubai time.`,
			};
		}

		return {
			...known,
			last_listing_ref: remembered.listing_ref,
			last_time_note: `Last time you viewed a property with ${remembered.agent}.`,
		};
	}

	if (remembered.last_action === "cancelled_viewing") {
		return { ...known, last_time_note: "You cancelled your last viewing." };
	}

	if (remembered.last_action === "seller_lead") {
		const rooms =
			remembered.bedrooms === 0
				? "studio"
				: `${remembered.bedrooms}-bedroom ${remembered.property_type.toLowerCase()}`;
		return { ...known, last_time_note: `You were selling your ${rooms} in ${remembered.area}.` };
	}

	return known;
}

/** Must match palm-marina-mcp's keys: KV keys only allow a-z A-Z 0-9 - _ / = . */
function kvSafe(phone: string): string {
	return phone.replace(/[^a-zA-Z0-9._=-]/g, "");
}

/** e.g. "Thursday 8 October at 4 pm", the way the calendar says it. */
function spokenTime(slotId: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Dubai",
		weekday: "long",
		day: "numeric",
		month: "long",
		hour: "numeric",
		hour12: true,
	}).format(new Date(slotId));
}
