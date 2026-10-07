/**
 * What we remember about a caller for their next call, as facts rather than a sentence. The dynamic variables webhook
 * reads `caller/<number>` at the start of a call and turns them into variables. Each caller only writes their own key.
 */

import type { Env } from "./env";

export type LastAction =
	| { last_action: "booked_viewing"; listing_ref: string; agent: string; viewing: string }
	| { last_action: "cancelled_viewing"; viewing: string }
	| { last_action: "seller_lead"; area: string; property_type: string; bedrooms: number };

/** KV keys only allow a-z A-Z 0-9 - _ / = . so the "+" of a number and the "@" of a SIP address are dropped. */
export function kvSafe(phone: string): string {
	return phone.replace(/[^a-zA-Z0-9._=-]/g, "");
}

/** Tool descriptions aren't filled in by Telnyx, so the model can copy "{{telnyx_end_user_target}}" as the number. */
export function callerPhone(args: Record<string, unknown>): string {
	const phone = typeof args.phone === "string" ? args.phone.trim() : "";
	return phone.includes("{{") ? "" : phone;
}

export async function rememberCaller(env: Env, phone: string, name: string, action: LastAction): Promise<void> {
	try {
		const caller = { name, ...action, updated_at: new Date().toISOString() };
		await env.KV.put(`caller/${kvSafe(phone)}`, JSON.stringify(caller));
	} catch {
		// Remembering only helps the next call; failing here must not undo the booking or lead just saved.
	}
}
