/**
 * A lead is saved under the caller's phone number, so two callers never overwrite each other's lead, and a seller
 * who calls again updates their own. In a real deployment leads would go into the brokerage's CRM.
 */

import { callerPhone, kvSafe, rememberCaller } from "../callers";

import type { Env } from "../env";
import type { ToolResult } from ".";

export const recordSellerLeadDefinition = {
	name: "record_seller_lead",
	description:
		"Record a seller lead: a caller who wants to sell a property. " +
		"Only call this after you have read the property details (name, area, type, bedrooms, asking price or 'to be agreed with your agent') back to the caller and the caller confirmed they are correct. " +
		"The lead is saved under the caller's phone number.",
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
				description:
					"The price the seller wants, in UAE dirhams. Omit when the caller has no price; the agent agrees it at the visit.",
			},
			size_sqft: {
				type: "number",
				description: "Size of the property in square feet. Only known when the seller asked for a valuation.",
			},
			caller_name: {
				type: "string",
				description:
					"The caller's name. Ask for it if you don't already have it (it is set for returning callers).",
			},
			phone: {
				type: "string",
				description: "The caller's number or caller ID, as given in your instructions.",
			},
		},
		required: ["area", "property_type", "bedrooms", "caller_name", "phone"],
	},
};

export async function recordSellerLead(args: Record<string, unknown>, env: Env): Promise<ToolResult> {
	const area = typeof args.area === "string" ? args.area.trim() : "";
	const propertyType = typeof args.property_type === "string" ? args.property_type.trim() : "";
	const callerName = typeof args.caller_name === "string" ? args.caller_name.trim() : "";
	const phone = callerPhone(args);

	if (!area) {
		return { isError: true, text: "area is required" };
	}

	if (!propertyType) {
		return { isError: true, text: "property_type is required" };
	}

	if (!callerName) {
		return { isError: true, text: "caller_name is required: ask the caller for their name first" };
	}

	// Any caller ID is fine for the lead: calls from a SIP or web client have a SIP address instead of a number.
	if (!phone) {
		return {
			isError: true,
			text: "phone is required: use the caller's number from your instructions, not a placeholder",
		};
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

	let askingPrice: number | null = null;
	if (args.asking_price !== undefined && args.asking_price !== null) {
		const price = Number(args.asking_price);
		if (!Number.isFinite(price) || price <= 0) {
			return {
				isError: true,
				text: `asking_price must be a number greater than 0, got ${JSON.stringify(args.asking_price)}`,
			};
		}

		askingPrice = price;
	}

	let sizeSqft: number | null = null;
	if (args.size_sqft !== undefined && args.size_sqft !== null) {
		const size = Number(args.size_sqft);
		if (!Number.isFinite(size) || size <= 0) {
			return {
				isError: true,
				text: `size_sqft must be a number greater than 0, got ${JSON.stringify(args.size_sqft)}`,
			};
		}

		sizeSqft = size;
	}

	const lead = {
		area,
		property_type: propertyType,
		bedrooms,
		asking_price: askingPrice,
		size_sqft: sizeSqft,
		caller_name: callerName,
		phone,
		recorded_at: new Date().toISOString(),
	};

	await env.KV.put(`lead/${kvSafe(phone)}`, JSON.stringify(lead));

	await rememberCaller(env, phone, callerName, {
		last_action: "seller_lead",
		area,
		property_type: propertyType,
		bedrooms,
	});
	return { isError: false, text: "Seller lead recorded.", outcome: "recorded" };
}

export const sendListingAgreementDefinition = {
	name: "send_listing_agreement",
	description:
		"Text the seller the link to sign the listing agreement (Form A) and upload photos of their property. " +
		"Returns whether the SMS was sent. Never read the link aloud.",
	inputSchema: {
		type: "object",
		properties: {
			phone: {
				type: "string",
				description:
					"The caller's phone number in E.164 format, e.g. +971501001001, as given in your instructions.",
			},
		},
		required: ["phone"],
	},
};

export async function sendListingAgreement(args: Record<string, unknown>): Promise<ToolResult> {
	const phone = callerPhone(args);

	if (!/^\+\d{8,15}$/.test(phone)) {
		return { isError: true, text: "phone must be in E.164 format", outcome: "bad_phone" };
	}

	const sms = await sendSms(
		phone,
		"Palm & Marina Realty: sign the listing agreement (Form A) and upload photos of your property here: " +
			"https://fake-sign-and-upload-pics-url.com"
	);

	if (!sms.ok) {
		return {
			isError: true,
			text: `SMS failed (${sms.error}). Tell the caller one of our agents will send them the listing agreement.`,
			outcome: "sms_failed",
		};
	}

	return { isError: false, text: "The listing agreement link was sent by text message.", outcome: "sent" };
}

/** The error is "<code> <title>", never Telnyx's detail: that has the phone number in it, and errors go into the log. */
async function sendSms(to: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const apiKey = process.env.TELNYX_API_KEY;
	if (!apiKey) {
		return { ok: false, error: "no API key" };
	}

	try {
		const res = await fetch("https://api.telnyx.com/v2/messages", {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				from: "PalmMarina",
				messaging_profile_id: "4001a117-0d16-4d0c-b289-b9909bea0b3f",
				to,
				text,
			}),
		});

		if (res.ok) {
			return { ok: true };
		}

		const body = (await res.json().catch(() => ({}))) as { errors?: Array<{ code?: string; title?: string }> };
		const error = body.errors?.[0];
		return { ok: false, error: error ? `${error.code} ${error.title}` : `HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}
