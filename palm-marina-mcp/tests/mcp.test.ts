import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import type { CloudStorageBucket, KvNamespace } from "@telnyx/edge-runtime";
import { ViewingCalendar } from "../src/calendar";
import { formatAmount } from "../src/listings";
import { actorNameFor } from "../src/tools/viewings";
import seedListings from "../data/listings.json";

const TEST_TOKEN = "test-secret-token";
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

function makeFakeEnv(opts?: { storage?: InMemoryStorage; kv?: FakeKv; bucket?: FakeBucket }): Env {
	const calendar = makeCalendar(opts?.storage);
	const kv = opts?.kv ?? new FakeKv();
	const bucket = opts?.bucket ?? seededBucket();
	return {
		MCP_TOKEN: TEST_TOKEN,
		CALENDAR: {
			idFromName: (name: string) => ({
				id: name,
				fetch: async () => new Response("not used in tests", { status: 501 }),
				getAvailableSlots: (limit?: number) => calendar.getAvailableSlots(limit),
				bookViewing: (slotId: string, callerName: string, listingRef: string) =>
					calendar.bookViewing(slotId, callerName, listingRef),
				cancelViewing: (bookingId: string) => calendar.cancelViewing(bookingId),
			}),
		} as unknown as Env["CALENDAR"],
		CACHE: kv as unknown as KvNamespace,
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

async function captureLogs(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const logs: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((s: string) => logs.push(s));
	await fn();
	spy.mockRestore();
	return logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
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

	it("tools/list returns all five tools", async () => {
		const result = (await rpc("tools/list")).result as Record<string, unknown>;
		const tools = result.tools as Array<{ name: string }>;
		expect(tools.map((t) => t.name)).toEqual([
			"search_listings",
			"get_available_slots",
			"book_viewing",
			"cancel_viewing",
			"record_seller_lead",
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
		const kv = env.CACHE as unknown as FakeKv;

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

	it("POST /admin/cache/clear makes the next call a miss again", async () => {
		const env = makeFakeEnv();
		await callTool("search_listings", { purpose: "buy" }, env);

		const { status, body } = await call("/admin/cache/clear", "POST", undefined, TEST_TOKEN, env);
		expect(status).toBe(200);
		expect((body as Record<string, unknown>).cleared).toBe("listings/v1");
		expect((env.CACHE as unknown as FakeKv).has("listings/v1")).toBe(false);

		const lines = await captureLogs(() => callTool("search_listings", { purpose: "buy" }, env));
		expect(lines[0].cache).toBe("miss");
	});

	it("bucket failure returns a clear tool error and does not populate KV", async () => {
		const env = makeFakeEnv({ bucket: new FakeBucket(undefined, { getThrows: true }) });
		const [isError, text] = await callTool("search_listings", { purpose: "buy" }, env);
		expect(isError).toBe(true);
		expect(text).toContain("unavailable");
		expect((env.CACHE as unknown as FakeKv).has("listings/v1")).toBe(false);
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

	it("book_viewing succeeds and returns a booking id", async () => {
		const { slots } = await calendar.getAvailableSlots(1);
		const slotId = slots[0].id;
		const result = await calendar.bookViewing(slotId, "James", "PMR-101");
		expect(result.status).toBe("booked");
		if (result.status === "booked") {
			expect(result.bookingId).toMatch(/^BK-/);
			expect(result.slotId).toBe(slotId);
			expect(result.slotVoice).toContain("at");
		}
	});

	it("double-booking the same slot is rejected", async () => {
		const { slots } = await calendar.getAvailableSlots(2);
		const slotId = slots[0].id;
		const first = await calendar.bookViewing(slotId, "James", "PMR-101");
		expect(first.status).toBe("booked");
		const second = await calendar.bookViewing(slotId, "Priya", "PMR-102");
		expect(second.status).toBe("slot_taken");
	});

	it("cancel_viewing removes the booking", async () => {
		const { slots } = await calendar.getAvailableSlots(1);
		const slotId = slots[0].id;
		const booked = await calendar.bookViewing(slotId, "James", "PMR-101");
		if (booked.status !== "booked") {
			throw new Error("expected booked");
		}
		const cancel = await calendar.cancelViewing(booked.bookingId);
		expect(cancel.status).toBe("cancelled");
		const rebook = await calendar.bookViewing(slotId, "Priya", "PMR-102");
		expect(rebook.status).toBe("booked");
	});

	it("cancel unknown booking id returns not_found", async () => {
		const result = await calendar.cancelViewing("BK-nonexistent");
		expect(result.status).toBe("not_found");
	});

	it("invalid slot id is rejected", async () => {
		const result = await calendar.bookViewing("not-a-real-slot", "James", "PMR-101");
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
			{ listing_ref: "PMR-101", slot_id: slotId, caller_name: "James" },
			env
		);
		expect(bookErr).toBe(false);
		expect(bookText).toContain("Booking confirmed");
		const bookingId = bookText.match(/ID (BK-[a-z0-9]+)/)?.[1];
		expect(bookingId).toBeTruthy();

		const [cancelErr, cancelText] = await callTool("cancel_viewing", { booking_id: bookingId }, env);
		expect(cancelErr).toBe(false);
		expect(cancelText).toContain("cancelled");
	});

	it("double-booking via MCP returns slot_taken", async () => {
		const env = makeFakeEnv();

		const [, slotsText] = await callTool("get_available_slots", { listing_ref: "PMR-101" }, env);
		const slotId = slotsText.match(/\(id: ([^)]+)\)/)?.[1]!;

		await callTool("book_viewing", { listing_ref: "PMR-101", slot_id: slotId, caller_name: "James" }, env);
		const [, text] = await callTool(
			"book_viewing",
			{ listing_ref: "PMR-101", slot_id: slotId, caller_name: "Priya" },
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
	it("saves a lead under its own key and returns an id", async () => {
		const env = makeFakeEnv();
		const [isError, text] = await callTool(
			"record_seller_lead",
			{
				area: "Dubai Marina",
				property_type: "Apartment",
				bedrooms: 2,
				asking_price: 3000000,
				caller_name: "James",
			},
			env
		);
		expect(isError).toBe(false);
		const id = text.match(/Lead id (\S+)\./)?.[1];
		expect(id).toMatch(/^SL-/);

		const kv = env.CACHE as unknown as FakeKv;
		const stored = kv.rawGet(`lead/${id}`);
		expect(stored).toBeDefined();
		const lead = JSON.parse(stored!);
		expect(lead.caller_name).toBe("James");
		expect(lead.area).toBe("Dubai Marina");
		expect(lead.bedrooms).toBe(2);
		expect(lead.asking_price).toBe(3000000);
	});

	it("never logs caller_name", async () => {
		const lines = await captureLogs(() =>
			callTool("record_seller_lead", {
				area: "Palm Jumeirah",
				property_type: "Villa",
				bedrooms: 4,
				asking_price: 18000000,
				caller_name: "Dmitri",
			})
		);
		expect(lines).toHaveLength(1);
		expect(lines[0].arguments).not.toHaveProperty("caller_name");
		expect(JSON.stringify(lines[0])).not.toContain("Dmitri");
	});

	it("missing required field is an error", async () => {
		const [isError] = await callTool("record_seller_lead", {
			area: "Dubai Marina",
			property_type: "Apartment",
			bedrooms: 2,
			caller_name: "James",
		});
		expect(isError).toBe(true);
	});

	it("does not need the bucket (writes straight to KV)", async () => {
		const env = makeFakeEnv({ bucket: new FakeBucket(undefined, { getThrows: true }) });
		const [isError, text] = await callTool(
			"record_seller_lead",
			{ area: "Downtown Dubai", property_type: "Apartment", bedrooms: 1, asking_price: 1500000, caller_name: "" },
			env
		);
		expect(isError).toBe(false);
		expect(text).toContain("Lead id");
	});
});

describe("admin routes", () => {
	it("require the bearer token", async () => {
		const env = makeFakeEnv();
		const clear = await call("/admin/cache/clear", "POST", undefined, null, env);
		expect(clear.status).toBe(401);
		const leads = await call("/admin/leads", "GET", undefined, null, env);
		expect(leads.status).toBe(401);
	});

	it("GET /admin/leads lists seller lead keys", async () => {
		const env = makeFakeEnv();
		await callTool(
			"record_seller_lead",
			{ area: "Dubai Marina", property_type: "Apartment", bedrooms: 1, asking_price: 1200000, caller_name: "A" },
			env
		);
		await callTool(
			"record_seller_lead",
			{ area: "Business Bay", property_type: "Apartment", bedrooms: 0, asking_price: 900000, caller_name: "B" },
			env
		);
		const { status, body } = await call("/admin/leads", "GET", undefined, TEST_TOKEN, env);
		expect(status).toBe(200);
		const leads = (body as Record<string, unknown>).leads as string[];
		expect(leads).toHaveLength(2);
		expect(leads.every((k) => k.startsWith("lead/SL-"))).toBe(true);
	});
});

describe("actorNameFor", () => {
	it("makes a Dapr-safe actor name from an agent's full name", () => {
		expect(actorNameFor("Layla Al Mansoori")).toBe("agent-layla-al-mansoori");
	});
});
