import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import type { CloudStorageBucket, KvNamespace } from "@telnyx/edge-runtime";
import { ViewingCalendar } from "../src/calendar";
import { formatAmount } from "../src/listings";
import { actorNameFor } from "../src/tools/viewings";
import seedListings from "../data/listings.json";

const TEST_TOKEN = "test-secret-token";

// On Edge the secret arrives as an environment variable, so the tests set one too.
beforeEach(() => {
	vi.stubEnv("MCP_TOKEN", TEST_TOKEN);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const SEED_LISTINGS_JSON = JSON.stringify(seedListings);

class InMemoryStorage {
	private map = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return (this.map.get(key) as T) ?? undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.map.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		return this.map.delete(key);
	}
}

function makeStorage(): InMemoryStorage {
	return new InMemoryStorage();
}

/** The real actor class, with an in-memory storage in place of the platform's. */
function makeCalendar(storage: InMemoryStorage = makeStorage()): ViewingCalendar {
	return new ViewingCalendar({ storage } as never, {} as never);
}

class FakeKv {
	private map = new Map<string, string>();
	async get<T>(key: string, options?: { type?: "text" | "json" }): Promise<T | string | null> {
		const v = this.map.get(key);
		if (v === undefined) {
			return null;
		}

		if (options?.type === "json") {
			return JSON.parse(v) as T;
		}

		return v;
	}

	async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
		// Same rule as the real KV, which answers other characters with a 400.
		if (!/^[a-zA-Z0-9._=/-]+$/.test(key)) {
			throw new Error(`KV put("${key}") failed: Invalid key format`);
		}

		this.map.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.map.delete(key);
	}

	async list(options?: { prefix?: string }): Promise<{
		keys: { name: string }[];
		list_complete: boolean;
		cursor?: string;
	}> {
		const prefix = options?.prefix;
		const keys = [...this.map.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name }));
		return { keys, list_complete: true };
	}

	has(key: string): boolean {
		return this.map.has(key);
	}

	rawGet(key: string): string | undefined {
		return this.map.get(key);
	}
}

class FakeBucket {
	private map = new Map<string, string>();
	private getThrows = false;
	constructor(seed?: Record<string, string>, opts?: { getThrows?: boolean }) {
		if (seed) {
			for (const [k, v] of Object.entries(seed)) this.map.set(k, v);
		}

		if (opts?.getThrows) {
			this.getThrows = true;
		}
	}

	async get(key: string): Promise<unknown> {
		if (this.getThrows) {
			throw new Error("bucket is down for tests");
		}

		const raw = this.map.get(key);
		if (raw === undefined) {
			return null;
		}

		const body = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(raw));
				c.close();
			},
		});
		return {
			key,
			body,
			bodyUsed: false,
			json: async () => JSON.parse(raw),
			text: async () => raw,
			arrayBuffer: async () => new TextEncoder().encode(raw).buffer,
			blob: async () => new Blob([raw]),
			writeHttpMetadata() {},
		};
	}
}

function seededBucket(): FakeBucket {
	return new FakeBucket({ "listings.json": SEED_LISTINGS_JSON });
}

function makeFakeEnv(opts?: { kv?: FakeKv; bucket?: FakeBucket }): Env {
	// One calendar per actor name, like the platform: each agent has their own bookings.
	const calendars = new Map<string, ViewingCalendar>();
	const calendarFor = (name: string) => {
		if (!calendars.has(name)) {
			calendars.set(name, makeCalendar());
		}

		return calendars.get(name)!;
	};
	const kv = opts?.kv ?? new FakeKv();
	const bucket = opts?.bucket ?? seededBucket();
	return {
		CALENDAR: {
			idFromName: (name: string) => ({
				id: name,
				fetch: async () => new Response("not used in tests", { status: 501 }),
				getAvailableSlots: (limit?: number) => calendarFor(name).getAvailableSlots(limit),
				bookViewing: (slotId: string, callerName: string, phone: string, listingRef: string) =>
					calendarFor(name).bookViewing(slotId, callerName, phone, listingRef),
				cancelViewing: (phone: string, callerName: string, date: string) =>
					calendarFor(name).cancelViewing(phone, callerName, date),
			}),
		} as unknown as Env["CALENDAR"],
		KV: kv as unknown as KvNamespace,
		FILES: bucket as unknown as CloudStorageBucket,
	};
}

async function call(
	path: string,
	method = "GET",
	body?: unknown,
	token: string | null = TEST_TOKEN,
	env?: Env
): Promise<{ status: number; body: unknown }> {
	const headers: Record<string, string> = {};
	if (token) {
		headers["Authorization"] = `Bearer ${token}`;
	}

	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		init.body = typeof body === "string" ? body : JSON.stringify(body);
		headers["Content-Type"] = "application/json";
	}

	const req = new Request(`https://test${path}`, init);
	const res = await handleRequest(req, env ?? makeFakeEnv());
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function rpc(
	method: string,
	params?: Record<string, unknown>,
	rpcId: unknown = 1,
	env?: Env
): Promise<Record<string, unknown>> {
	const { status, body } = await call(
		"/mcp",
		"POST",
		{ jsonrpc: "2.0", id: rpcId, method, params: params ?? {} },
		TEST_TOKEN,
		env
	);
	expect(status).toBe(200);
	return body as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>, env?: Env): Promise<[boolean, string]> {
	const result = (await rpc("tools/call", { name, arguments: args }, 1, env)).result as Record<string, unknown>;
	return [result.isError as boolean, (result.content as Array<{ text: string }>)[0].text];
}

/** Our JSON log lines, from stdout and stderr, each tagged with the stream it went to. */
async function captureLogs(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const logs: Array<[string, string]> = [];
	const out = vi.spyOn(console, "log").mockImplementation((s: string) => logs.push(["stdout", s]));
	const err = vi.spyOn(console, "error").mockImplementation((s: string) => logs.push(["stderr", s]));
	await fn();
	out.mockRestore();
	err.mockRestore();
	return logs.filter(([, l]) => l.startsWith("{")).map(([stream, l]) => ({ ...JSON.parse(l), _stream: stream }));
}

describe("auth", () => {
	it("health is public without token", async () => {
		const { status, body } = await call("/health", "GET", undefined, null);
		expect(status).toBe(200);
		expect((body as Record<string, unknown>).status).toBe("ok");
	});

	it("missing token is 401", async () => {
		const { status, body } = await call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "ping" }, null);
		expect(status).toBe(401);
		expect((body as Record<string, unknown>).error).toBe("unauthorized");
	});

	it("wrong token is 401", async () => {
		const { status } = await call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong");
		expect(status).toBe(401);
	});

	it("unauthorized is logged without token value", async () => {
		const logLines = await captureLogs(() => call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "ping" }, null));
		expect(logLines).toHaveLength(1);
		expect(logLines[0].outcome).toBe("unauthorized");
		expect(JSON.stringify(logLines[0])).not.toContain("test-secret-token");
	});
});

describe("JSON-RPC protocol", () => {
	it("initialize echoes protocol version", async () => {
		const result = (await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} })).result as Record<
			string,
			unknown
		>;
		expect(result.protocolVersion).toBe("2025-03-26");
		expect(result.capabilities).toHaveProperty("tools");
	});

	it("notification gets 202 and no body", async () => {
		const { status, body } = await call("/mcp", "POST", { jsonrpc: "2.0", method: "notifications/initialized" });
		expect(status).toBe(202);
		expect(body).toBeNull();
	});

	it("tools/list returns all seven tools", async () => {
		const result = (await rpc("tools/list")).result as Record<string, unknown>;
		const tools = result.tools as Array<{ name: string }>;
		expect(tools.map((t) => t.name)).toEqual([
			"search_listings",
			"get_available_slots",
			"book_viewing",
			"cancel_viewing",
			"record_seller_lead",
			"estimate_value",
			"send_listing_agreement",
		]);
	});

	it("unknown method returns -32601", async () => {
		const body = await rpc("resources/list");
		expect((body.error as Record<string, unknown>).code).toBe(-32601);
	});

	it("invalid json returns -32700", async () => {
		const { body } = await call("/mcp", "POST", "{not json");
		expect((body as Record<string, unknown>).error).toBeTruthy();
	});

	it("non-object body returns 400", async () => {
		const { status, body } = await call("/mcp", "POST", [1, 2]);
		expect(status).toBe(400);
		expect((body as Record<string, unknown>).error).toBeTruthy();
	});
});

describe("search_listings", () => {
	it("returns spoken summary with one match", async () => {
		const [isError, text] = await callTool("search_listings", {
			purpose: "buy",
			area: "Dubai Marina",
			bedrooms: 2,
		});
		expect(isError).toBe(false);
		expect(text.startsWith("I found one matching property")).toBe(true);
	});

	it("no matches is not an error", async () => {
		const [isError, text] = await callTool("search_listings", { purpose: "buy", budget: 100000 });
		expect(isError).toBe(false);
		expect(text).toContain("couldn't find");
	});

	it("area must be a known area", async () => {
		const [isError, text] = await callTool("search_listings", { area: "JBR" });
		expect(isError).toBe(true);
		expect(text).toContain("Jumeirah Beach Residence");
	});

	it("area enum comes from listings", async () => {
		const result = (await rpc("tools/list")).result as Record<string, unknown>;
		const tools = result.tools as Array<Record<string, unknown>>;
		const areaProp = (tools[0].inputSchema as Record<string, unknown>).properties as Record<
			string,
			{ enum: string[] }
		>;
		expect(areaProp.area.enum).toContain("Jumeirah Beach Residence");
	});

	it("bad budget argument", async () => {
		const [isError, text] = await callTool("search_listings", { budget: "cheap" });
		expect(isError).toBe(true);
		expect(text).toContain("budget");
	});

	it("results include the property reference", async () => {
		const [, text] = await callTool("search_listings", { purpose: "buy", area: "Dubai Marina", bedrooms: 2 });
		expect(text).toContain("Ref PMR-101");
	});

	it("many matches describes only three", async () => {
		const [, text] = await callTool("search_listings", { purpose: "rent" });
		expect(text.startsWith("I found 4 matching properties. Here are the first 3.")).toBe(true);
		expect(text).toContain("Option 3");
		expect(text).not.toContain("Option 4");
	});
});

describe("formatAmount (prices not rounded)", () => {
	it("2,550,000 is 2.55 million", () => {
		expect(formatAmount(2_550_000)).toBe("2.55 million");
	});
	it("3,000,000 is 3 million", () => {
		expect(formatAmount(3_000_000)).toBe("3 million");
	});
	it("95,000 is 95 thousand", () => {
		expect(formatAmount(95_000)).toBe("95 thousand");
	});
});

describe("logging", () => {
	it("one JSON log line per request", async () => {
		const logLines = await captureLogs(() => callTool("search_listings", { budget: "cheap" }));
		expect(logLines).toHaveLength(1);
		expect(logLines[0].rpc_method).toBe("tools/call");
		expect(logLines[0].outcome).toBe("bad_args");
	});
});

describe("listings cache (KV in front of the bucket)", () => {
	it("first call is a miss, the second a hit", async () => {
		const env = makeFakeEnv();
		const kv = env.KV as unknown as FakeKv;

		const lines = await captureLogs(() =>
			callTool("search_listings", { purpose: "buy", area: "Dubai Marina", bedrooms: 2 }, env).then(() =>
				callTool("search_listings", { purpose: "buy", area: "Dubai Marina", bedrooms: 2 }, env)
			)
		);
		expect(lines).toHaveLength(2);
		expect(lines[0].cache).toBe("miss");
		expect(lines[1].cache).toBe("hit");
		expect(kv.has("listings/v1")).toBe(true);
	});

	it("bucket failure answers with a tool error that offers an agent, and does not populate KV", async () => {
		const env = makeFakeEnv({ bucket: new FakeBucket(undefined, { getThrows: true }) });
		const lines = await captureLogs(async () => {
			const [isError, text] = await callTool("search_listings", { purpose: "buy" }, env);
			expect(isError).toBe(true);
			expect(text).toContain("offer to put the caller through to one of our agents");
		});
		expect(lines[0]).toMatchObject({ outcome: "exception" });
		expect(lines[0].error).toContain("bucket is down");
		expect((env.KV as unknown as FakeKv).has("listings/v1")).toBe(false);
	});

	it("seller tools don't read the listings, so they still work when the listings are unavailable", async () => {
		const env = makeFakeEnv({ bucket: new FakeBucket(undefined, { getThrows: true }) });
		const lines = await captureLogs(async () => {
			const [isError, text] = await callTool(
				"record_seller_lead",
				{
					area: "Dubai Marina",
					property_type: "Apartment",
					bedrooms: 2,
					caller_name: "James",
					phone: "+971501001099",
				},
				env
			);
			expect(isError).toBe(false);
			expect(text).toBe("Seller lead recorded.");
		});
		expect(lines[0].cache).toBeUndefined();
	});

	it("bucket failure on tools/list returns a 500", async () => {
		const env = makeFakeEnv({ bucket: new FakeBucket(undefined, { getThrows: true }) });
		const { status } = await call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, TEST_TOKEN, env);
		expect(status).toBe(500);
	});
});

describe("calendar actor (in-memory storage)", () => {
	let calendar: ViewingCalendar;
	beforeEach(() => {
		calendar = makeCalendar();
	});

	it("get_available_slots returns future slots", async () => {
		const { slots } = await calendar.getAvailableSlots(4);
		expect(slots.length).toBeGreaterThan(0);
		expect(slots.length).toBeLessThanOrEqual(4);
		expect(slots[0].id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00\+04:00$/);
		expect(slots[0].voice).toContain("at");
	});

	it("book_viewing succeeds", async () => {
		const { slots } = await calendar.getAvailableSlots(1);
		const slotId = slots[0].id;
		const result = await calendar.bookViewing(slotId, "James", "+971501001099", "PMR-101");
		expect(result.status).toBe("booked");
		if (result.status === "booked") {
			expect(result.slotId).toBe(slotId);
			expect(result.slotVoice).toContain("at");
		}
	});

	it("double-booking the same slot is rejected", async () => {
		const { slots } = await calendar.getAvailableSlots(2);
		const slotId = slots[0].id;
		const first = await calendar.bookViewing(slotId, "James", "+971501001099", "PMR-101");
		expect(first.status).toBe("booked");
		const second = await calendar.bookViewing(slotId, "Priya", "+971501001098", "PMR-102");
		expect(second.status).toBe("slot_taken");
	});

	it("cancel_viewing finds the booking by the caller's number and day, and frees the slot", async () => {
		const { slots } = await calendar.getAvailableSlots(1);
		const slotId = slots[0].id;
		await calendar.bookViewing(slotId, "James", "+971501001099", "PMR-101");

		const cancel = await calendar.cancelViewing("+971501001099", "", slotId.slice(0, 10));
		expect(cancel).toEqual({ status: "cancelled", slotId, slotVoice: slots[0].voice, callerName: "James" });

		const rebook = await calendar.bookViewing(slotId, "Priya", "+971501001098", "PMR-102");
		expect(rebook.status).toBe("booked");
	});

	it("cancel_viewing falls back to the name when the caller uses another phone", async () => {
		const { slots } = await calendar.getAvailableSlots(1);
		const slotId = slots[0].id;
		await calendar.bookViewing(slotId, "James", "+971501001099", "PMR-101");

		const cancel = await calendar.cancelViewing("+447700900123", "james", slotId.slice(0, 10));
		expect(cancel.status).toBe("cancelled");
	});

	it("cancel with the wrong caller or day returns not_found, and an empty name never matches", async () => {
		const { slots } = await calendar.getAvailableSlots(1);
		const slotId = slots[0].id;
		await calendar.bookViewing(slotId, "", "+971501001099", "PMR-101");

		expect((await calendar.cancelViewing("+447700900123", "", slotId.slice(0, 10))).status).toBe("not_found");
		expect((await calendar.cancelViewing("+971501001099", "", "2000-01-01")).status).toBe("not_found");
	});

	it("invalid slot id is rejected", async () => {
		const result = await calendar.bookViewing("not-a-real-slot", "James", "+971501001099", "PMR-101");
		expect(result.status).toBe("invalid_slot");
	});
});

describe("booking tools via MCP", () => {
	it("get_available_slots + book_viewing + cancel_viewing end to end", async () => {
		const env = makeFakeEnv();

		const [, slotsText] = await callTool("get_available_slots", { listing_ref: "PMR-101" }, env);
		expect(slotsText).toContain("Layla Al Mansoori");
		const slotId = slotsText.match(/\(id: ([^)]+)\)/)?.[1];
		expect(slotId).toBeTruthy();

		const [bookErr, bookText] = await callTool(
			"book_viewing",
			{ listing_ref: "PMR-101", slot_id: slotId, caller_name: "James", phone: "+971501001099" },
			env
		);
		expect(bookErr).toBe(false);
		expect(bookText).toContain("Booking confirmed under the name James");

		const [cancelErr, cancelText] = await callTool(
			"cancel_viewing",
			{ phone: "+971501001099", date: slotId!.slice(0, 10) },
			env
		);
		expect(cancelErr).toBe(false);
		expect(cancelText).toContain("has been cancelled");
	});

	it("book_viewing needs a name", async () => {
		const [, slotsText] = await callTool("get_available_slots", { listing_ref: "PMR-101" });
		const slotId = slotsText.match(/\(id: ([^)]+)\)/)?.[1];

		const [isError, text] = await callTool("book_viewing", {
			listing_ref: "PMR-101",
			slot_id: slotId,
			caller_name: "",
			phone: "+971501001099",
		});
		expect(isError).toBe(true);
		expect(text).toContain("ask the caller for their name");
	});

	it("cancel_viewing with no matching booking is not an error, so the name and number stay out of the log", async () => {
		const lines = await captureLogs(() =>
			callTool("cancel_viewing", { phone: "+971501001099", caller_name: "Dmitri", date: "2026-10-10" })
		);
		expect(lines).toHaveLength(1);
		expect(lines[0].outcome).toBe("not_found");
		expect(JSON.stringify(lines[0])).not.toContain("Dmitri");
		expect(JSON.stringify(lines[0])).not.toContain("971501001099");
	});

	it("double-booking via MCP returns slot_taken", async () => {
		const env = makeFakeEnv();

		const [, slotsText] = await callTool("get_available_slots", { listing_ref: "PMR-101" }, env);
		const slotId = slotsText.match(/\(id: ([^)]+)\)/)?.[1]!;

		await callTool(
			"book_viewing",
			{ listing_ref: "PMR-101", slot_id: slotId, caller_name: "James", phone: "+971501001099" },
			env
		);
		const [, text] = await callTool(
			"book_viewing",
			{ listing_ref: "PMR-101", slot_id: slotId, caller_name: "Priya", phone: "+971501001098" },
			env
		);
		expect(text).toContain("just taken");
	});

	it("unknown listing ref is an error", async () => {
		const [isError, text] = await callTool("get_available_slots", { listing_ref: "PMR-999" });
		expect(isError).toBe(true);
		expect(text).toContain("Unknown listing");
	});
});

describe("record_seller_lead", () => {
	it("saves the lead under the caller's phone number", async () => {
		const env = makeFakeEnv();
		const [isError, text] = await callTool(
			"record_seller_lead",
			{
				area: "Dubai Marina",
				property_type: "Apartment",
				bedrooms: 2,
				asking_price: 3000000,
				caller_name: "James",
				phone: "+971501001099",
			},
			env
		);
		expect(isError).toBe(false);
		expect(text).toBe("Seller lead recorded.");

		const kv = env.KV as unknown as FakeKv;
		const stored = kv.rawGet("lead/971501001099");
		expect(stored).toBeDefined();
		const lead = JSON.parse(stored!);
		expect(lead.caller_name).toBe("James");
		expect(lead.area).toBe("Dubai Marina");
		expect(lead.bedrooms).toBe(2);
		expect(lead.asking_price).toBe(3000000);
		expect(lead.phone).toBe("+971501001099");
	});

	it("never logs caller_name", async () => {
		const lines = await captureLogs(() =>
			callTool("record_seller_lead", {
				area: "Palm Jumeirah",
				property_type: "Villa",
				bedrooms: 4,
				asking_price: 18000000,
				caller_name: "Dmitri",
				phone: "+971501001099",
			})
		);
		expect(lines).toHaveLength(1);
		expect(lines[0].arguments).not.toHaveProperty("caller_name");
		expect(JSON.stringify(lines[0])).not.toContain("Dmitri");
		expect(JSON.stringify(lines[0])).not.toContain("+971501001099");
	});

	it("accepts a SIP caller ID, because web and SIP calls have no phone number", async () => {
		const env = makeFakeEnv();
		const [isError] = await callTool(
			"record_seller_lead",
			{
				area: "Dubai Marina",
				property_type: "Apartment",
				bedrooms: 2,
				caller_name: "James",
				phone: "abc123@sip.telnyx.eu",
			},
			env
		);
		expect(isError).toBe(false);
		expect((env.KV as unknown as FakeKv).has("lead/abc123sip.telnyx.eu")).toBe(true);
	});

	it("rejects a lead without a phone or caller ID", async () => {
		const [isError, text] = await callTool("record_seller_lead", {
			area: "Dubai Marina",
			property_type: "Apartment",
			bedrooms: 2,
			caller_name: "James",
		});
		expect(isError).toBe(true);
		expect(text).toContain("phone is required");
	});

	it("missing caller_name is an error", async () => {
		const [isError, text] = await callTool("record_seller_lead", {
			area: "Dubai Marina",
			property_type: "Apartment",
			bedrooms: 2,
			phone: "+971501001099",
			asking_price: 3000000,
		});
		expect(isError).toBe(true);
		expect(text).toContain("caller_name is required");
	});

	it("rejects an empty caller_name", async () => {
		const [isError, text] = await callTool("record_seller_lead", {
			area: "Dubai Marina",
			property_type: "Apartment",
			bedrooms: 2,
			caller_name: "   ",
			phone: "+971501001099",
		});
		expect(isError).toBe(true);
		expect(text).toContain("caller_name is required");
	});

	it("works without an asking price and stores size_sqft", async () => {
		const env = makeFakeEnv();
		const [isError, text] = await callTool(
			"record_seller_lead",
			{
				area: "Dubai Marina",
				property_type: "Apartment",
				bedrooms: 2,
				size_sqft: 1400,
				caller_name: "James",
				phone: "+971501001099",
			},
			env
		);
		expect(isError).toBe(false);
		expect(text).toBe("Seller lead recorded.");

		const lead = JSON.parse((env.KV as unknown as FakeKv).rawGet("lead/971501001099")!);
		expect(lead.asking_price).toBeNull();
		expect(lead.size_sqft).toBe(1400);
		expect(lead.caller_name).toBe("James");
	});
});

describe("remembering callers for their next call", () => {
	async function bookFirstSlot(env: Env): Promise<string> {
		const [, slotsText] = await callTool("get_available_slots", { listing_ref: "PMR-101" }, env);
		const slotId = slotsText.match(/\(id: ([^)]+)\)/)?.[1] ?? "";
		await callTool(
			"book_viewing",
			{ listing_ref: "PMR-101", slot_id: slotId, caller_name: "James", phone: "+971501001099" },
			env
		);
		return slotId;
	}

	it("a booking saves the caller's name and the facts of the booking under caller/<number>", async () => {
		const env = makeFakeEnv();
		await bookFirstSlot(env);

		const caller = JSON.parse((env.KV as unknown as FakeKv).rawGet("caller/971501001099")!);
		expect(caller).toMatchObject({
			name: "James",
			last_action: "booked_viewing",
			listing_ref: "PMR-101",
			agent: "Layla Al Mansoori",
		});
		expect(caller.viewing).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00\+04:00$/);
	});

	it("a cancel records the cancelled viewing and keeps the name from the booking", async () => {
		const env = makeFakeEnv();
		const slotId = await bookFirstSlot(env);

		await callTool("cancel_viewing", { phone: "+971501001099", date: slotId.slice(0, 10) }, env);

		const caller = JSON.parse((env.KV as unknown as FakeKv).rawGet("caller/971501001099")!);
		expect(caller).toMatchObject({ name: "James", last_action: "cancelled_viewing", viewing: slotId });
	});

	it("a seller lead saves what they want to sell", async () => {
		const env = makeFakeEnv();
		await callTool(
			"record_seller_lead",
			{
				area: "Dubai Hills Estate",
				property_type: "Villa",
				bedrooms: 3,
				asking_price: 3600000,
				caller_name: "Omar",
				phone: "+971501001099",
			},
			env
		);

		const caller = JSON.parse((env.KV as unknown as FakeKv).rawGet("caller/971501001099")!);
		expect(caller).toMatchObject({
			name: "Omar",
			last_action: "seller_lead",
			area: "Dubai Hills Estate",
			property_type: "Villa",
			bedrooms: 3,
		});
	});

	it("a failure to remember never undoes the booking", async () => {
		class CallersDownKv extends FakeKv {
			async put(key: string, value: string): Promise<void> {
				if (key.startsWith("caller/")) {
					throw new Error("KV down");
				}

				return super.put(key, value);
			}
		}

		const env = makeFakeEnv({ kv: new CallersDownKv() });
		const [, slotsText] = await callTool("get_available_slots", { listing_ref: "PMR-101" }, env);
		const slotId = slotsText.match(/\(id: ([^)]+)\)/)?.[1];
		const [isError, text] = await callTool(
			"book_viewing",
			{ listing_ref: "PMR-101", slot_id: slotId, caller_name: "James", phone: "+971501001099" },
			env
		);
		expect(isError).toBe(false);
		expect(text).toContain("Booking confirmed");
	});
});

describe("the caller's number", () => {
	it("an unfilled {{telnyx_end_user_target}} placeholder counts as missing", async () => {
		const [, slotsText] = await callTool("get_available_slots", { listing_ref: "PMR-101" });
		const slotId = slotsText.match(/\(id: ([^)]+)\)/)?.[1];

		const [isError, text] = await callTool("book_viewing", {
			listing_ref: "PMR-101",
			slot_id: slotId,
			caller_name: "Omar",
			phone: "{{telnyx_end_user_target}}",
		});
		expect(isError).toBe(true);
		expect(text).toContain("not a placeholder");
	});
});

describe("a tool that crashes", () => {
	it("answers at once with an error that offers an agent, and masks the number in the log", async () => {
		class LeadsDownKv extends FakeKv {
			async put(key: string, value: string): Promise<void> {
				if (key.startsWith("lead/")) {
					throw new Error(`KV put("${key}") failed: HTTP 503`);
				}

				return super.put(key, value);
			}
		}

		const env = makeFakeEnv({ kv: new LeadsDownKv() });
		let answer: [boolean, string] = [false, ""];
		const lines = await captureLogs(async () => {
			answer = await callTool(
				"record_seller_lead",
				{
					area: "Dubai Marina",
					property_type: "Apartment",
					bedrooms: 2,
					caller_name: "James",
					phone: "+971501001099",
				},
				env
			);
		});

		expect(answer[0]).toBe(true);
		expect(answer[1]).toContain("offer to put the caller through to one of our agents");
		expect(lines[0].outcome).toBe("exception");
		expect(JSON.stringify(lines[0])).toContain("[number]");
		expect(JSON.stringify(lines[0])).not.toContain("971501001099");
	});
});

describe("actorNameFor", () => {
	it("makes a Dapr-safe actor name from an agent's full name", () => {
		expect(actorNameFor("Layla Al Mansoori")).toBe("agent-layla-al-mansoori");
	});
});

describe("missing secret", () => {
	it("rejects every MCP request when MCP_TOKEN is not set", async () => {
		vi.stubEnv("MCP_TOKEN", "");
		const { status } = await call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "ping" });
		expect(status).toBe(401);
	});
});

describe("tracing and log levels", () => {
	it("logs the call's conversation id sent in _meta", async () => {
		const logLines = await captureLogs(() =>
			rpc("tools/call", {
				name: "search_listings",
				arguments: { purpose: "buy" },
				_meta: { telnyx_conversation_id: "conv-123" },
			})
		);
		expect(logLines[0].conversation_id).toBe("conv-123");
		expect(logLines[0]._stream).toBe("stdout");
	});

	it("writes failures to stderr", async () => {
		const logLines = await captureLogs(() => call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "ping" }, null));
		expect(logLines[0].outcome).toBe("unauthorized");
		expect(logLines[0]._stream).toBe("stderr");
	});
});

describe("estimate_value", () => {
	it("gives a range from the price per square foot of the same type in the same area", async () => {
		// Dubai Marina: one 2-bed apartment for sale, 2,500,000 for 1,320 sq ft (about 1,894 per sq ft).
		const [isError, text] = await callTool("estimate_value", {
			area: "Dubai Marina",
			property_type: "Apartment",
			size_sqft: 1400,
		});
		expect(isError).toBe(false);
		expect(text).toContain("about 1,894 dirhams per square foot");
		expect(text).toContain("roughly 2.4 million to 2.9 million dirhams");
		expect(text).toContain("not a valuation");
	});

	it("offers the listing areas plus Other, so the model picks the name", async () => {
		const tools = ((await rpc("tools/list")).result as { tools: Array<{ name: string; inputSchema: any }> }).tools;
		const areaEnum = tools.find((t) => t.name === "estimate_value")!.inputSchema.properties.area.enum;
		expect(areaEnum).toContain("Dubai Hills Estate");
		expect(areaEnum[areaEnum.length - 1]).toBe("Other");
	});

	it("treats Other as nothing to compare with", async () => {
		const [isError, text] = await callTool("estimate_value", {
			area: "Other",
			property_type: "Apartment",
			size_sqft: 900,
		});
		expect(isError).toBe(false);
		expect(text).toContain("in that area");
		expect(text).toContain("put you through to one of our agents");
	});

	it("offers an agent when there is nothing for sale in the area to compare with", async () => {
		const [isError, text] = await callTool("estimate_value", {
			area: "Jumeirah Lakes Towers",
			property_type: "Apartment",
			size_sqft: 900,
		});
		expect(isError).toBe(false);
		expect(text).toContain("put you through to one of our agents");
	});

	it("never compares an apartment with a villa", async () => {
		// Dubai Hills Estate only has a villa for sale.
		const [isError, text] = await callTool("estimate_value", {
			area: "Dubai Hills Estate",
			property_type: "Apartment",
			size_sqft: 1200,
		});
		expect(isError).toBe(false);
		expect(text).toContain("We don't have a similar apartment for sale in Dubai Hills Estate");
		expect(text).toContain("put you through to one of our agents");
	});

	it("rejects a missing size", async () => {
		const [isError, text] = await callTool("estimate_value", { area: "Dubai Marina", property_type: "Apartment" });
		expect(isError).toBe(true);
		expect(text).toContain("size_sqft");
	});
});

describe("send_listing_agreement", () => {
	it("texts the link to the caller's number from PalmMarina", async () => {
		vi.stubEnv("TELNYX_API_KEY", "test-key");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

		const [isError, text] = await callTool("send_listing_agreement", { phone: "+971501001099" });
		expect(isError).toBe(false);
		expect(text).toContain("listing agreement link was sent");

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.telnyx.com/v2/messages");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
		const body = JSON.parse(init.body as string) as Record<string, string>;
		expect(body.from).toBe("PalmMarina");
		expect(body.messaging_profile_id).toBe("4001a117-0d16-4d0c-b289-b9909bea0b3f");
		expect(body.to).toBe("+971501001099");
		expect(body.text).toContain("https://fake-sign-and-upload-pics-url.com");
	});

	it("a 400 with code 40305 is sms_failed and the phone never appears in the log", async () => {
		vi.stubEnv("TELNYX_API_KEY", "test-key");
		const phone = "+971501001099";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					errors: [
						{
							code: "40305",
							title: "Invalid 'from' address",
							detail: `Alphanumeric sender ID PalmMarina is not registered for the destination number ${phone}`,
						},
					],
				}),
				{ status: 400, headers: { "content-type": "application/json" } }
			)
		);

		const lines = await captureLogs(() => callTool("send_listing_agreement", { phone }));
		expect(lines[0].outcome).toBe("sms_failed");
		expect(JSON.stringify(lines[0])).toContain("40305");
		expect(JSON.stringify(lines[0])).not.toContain(phone);
	});

	it("rejects a phone that is not E.164 without calling Telnyx", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const [isError, text] = await callTool("send_listing_agreement", { phone: "0123" });
		expect(isError).toBe(true);
		expect(text).toBe("phone must be in E.164 format");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("missing TELNYX_API_KEY is sms_failed and does not call Telnyx", async () => {
		vi.stubEnv("TELNYX_API_KEY", "");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const [isError, text] = await callTool("send_listing_agreement", { phone: "+971501001099" });
		expect(isError).toBe(true);
		expect(text).toContain("no API key");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
