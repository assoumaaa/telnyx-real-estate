import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { handleRequest } from "../src/index";

const SIP_CALLER = "abc123@sip.telnyx.eu";
const UPCOMING_VIEWING = {
	name: "Omar",
	last_action: "booked_viewing",
	listing_ref: "PMR-102",
	agent: "Layla Al Mansoori",
	viewing: "2026-10-08T16:00+04:00",
};

/** A fake KV holding caller/<number> summaries; kvDown makes every read fail. */
function makeEnv(kv: Record<string, unknown> = {}, kvDown = false): Env {
	return {
		KV: {
			get: async (key: string) => {
				if (kvDown) {
					throw new Error("KV get(caller/971501001099) failed");
				}

				return kv[key] ?? null;
			},
		},
	} as unknown as Env;
}

async function webhook(caller: string, env: Env): Promise<Record<string, string>> {
	const event = { data: { payload: { telnyx_end_user_target: caller, telnyx_conversation_channel: "phone_call" } } };
	const res = await handleRequest(
		new Request("https://example.com/", { method: "POST", body: JSON.stringify(event) }),
		env
	);
	expect(res.status).toBe(200);
	return ((await res.json()) as { dynamic_variables: Record<string, string> }).dynamic_variables;
}

/** Our JSON log lines, from stdout and stderr, each tagged with the stream it went to. */
async function captureLogs(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const logs: Array<[string, string]> = [];
	const out = vi.spyOn(console, "log").mockImplementation((s: string) => logs.push(["stdout", s]));
	const err = vi.spyOn(console, "error").mockImplementation((s: string) => logs.push(["stderr", s]));
	await fn();
	out.mockRestore();
	err.mockRestore();
	return logs.map(([stream, line]) => ({ ...JSON.parse(line), _stream: stream }));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("returning callers, from caller/<number> in KV", () => {
	it("an upcoming viewing gives the agent, time and property", async () => {
		const env = makeEnv({ "caller/abc123sip.telnyx.eu": UPCOMING_VIEWING });
		const lines = await captureLogs(async () => {
			const variables = await webhook(SIP_CALLER, env);
			expect(variables).toMatchObject({
				caller_name: "Omar",
				is_returning_caller: "true",
				has_upcoming_viewing: "true",
				last_listing_ref: "PMR-102",
				last_time_note: "You have a viewing with Layla Al Mansoori on Thursday 8 October at 4 pm Dubai time.",
			});
		});
		expect(lines[0].outcome).toBe("returning_caller");
	});

	it("a viewing that already happened becomes last time", async () => {
		const past = { ...UPCOMING_VIEWING, viewing: "2026-10-01T10:00+04:00" };
		const variables = await webhook(SIP_CALLER, makeEnv({ "caller/abc123sip.telnyx.eu": past }));
		expect(variables).toMatchObject({
			has_upcoming_viewing: "false",
			last_listing_ref: "PMR-102",
			last_time_note: "Last time you viewed a property with Layla Al Mansoori.",
		});
	});

	it("a cancelled viewing", async () => {
		const cancelled = { name: "Omar", last_action: "cancelled_viewing", viewing: "2026-10-08T16:00+04:00" };
		const variables = await webhook(SIP_CALLER, makeEnv({ "caller/abc123sip.telnyx.eu": cancelled }));
		expect(variables.last_time_note).toBe("You cancelled your last viewing.");
	});

	it("a seller", async () => {
		const seller = {
			name: "Omar",
			last_action: "seller_lead",
			area: "Dubai Hills Estate",
			property_type: "Villa",
			bedrooms: 3,
		};
		const variables = await webhook(SIP_CALLER, makeEnv({ "caller/abc123sip.telnyx.eu": seller }));
		expect(variables.last_time_note).toBe("You were selling your 3-bedroom villa in Dubai Hills Estate.");
	});

	it("an older record without a known action still gives the name", async () => {
		const variables = await webhook(SIP_CALLER, makeEnv({ "caller/abc123sip.telnyx.eu": { name: "Omar" } }));
		expect(variables).toMatchObject({ caller_name: "Omar", is_returning_caller: "true", last_time_note: "" });
	});

	it("a number we haven't met is a new caller", async () => {
		const lines = await captureLogs(async () => {
			const variables = await webhook("+447911123456", makeEnv());
			expect(variables.is_returning_caller).toBe("false");
		});
		expect(lines[0].outcome).toBe("new_caller");
	});

	it("a KV failure treats the caller as new and logs it without the number", async () => {
		const lines = await captureLogs(async () => {
			const variables = await webhook(SIP_CALLER, makeEnv({}, true));
			expect(variables.is_returning_caller).toBe("false");
		});
		expect(lines[0]).toMatchObject({ outcome: "exception", _stream: "stderr" });
		expect(lines[0].error).toContain("[number]");
		expect(JSON.stringify(lines[0])).not.toContain("971501001099");
	});
});

describe("masking", () => {
	it("only the last two characters of the number reach the log", async () => {
		const lines = await captureLogs(() => webhook("+447911123456", makeEnv()));
		expect(lines[0].caller_masked).toBe("***********56");
		expect(JSON.stringify(lines[0])).not.toContain("447911123456");
	});
});

describe("requests that aren't a normal call start", () => {
	it("a bad body still answers with new-caller defaults and logs an error", async () => {
		const lines = await captureLogs(async () => {
			const res = await handleRequest(
				new Request("https://example.com/", { method: "POST", body: "{not json" }),
				makeEnv()
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { dynamic_variables: Record<string, string> };
			expect(body.dynamic_variables.is_returning_caller).toBe("false");
		});
		expect(lines[0]).toMatchObject({ outcome: "bad_body", _stream: "stderr" });
	});

	it("health is up, other paths are 404 and GET on / is 405", async () => {
		const env = makeEnv();
		expect((await handleRequest(new Request("https://example.com/health"), env)).status).toBe(200);
		expect((await handleRequest(new Request("https://example.com/nope"), env)).status).toBe(404);
		expect((await handleRequest(new Request("https://example.com/"), env)).status).toBe(405);
	});
});
