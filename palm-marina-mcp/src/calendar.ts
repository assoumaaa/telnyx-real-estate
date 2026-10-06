import type { Listing } from "./listings";
import { StatefulActor } from "@telnyx/edge-runtime";

export interface Slot {
	id: string;
	voice: string;
	utcMs: number;
}

export interface Booking {
	bookingId: string;
	slotId: string;
	callerName: string;
	listingRef: string;
	bookedAt: string;
}

export interface AvailableSlotsResult {
	slots: Slot[];
}

export type BookResult =
	| { status: "booked"; bookingId: string; slotId: string; slotVoice: string }
	| { status: "slot_taken"; slotId: string; nextSlots: Slot[] }
	| { status: "invalid_slot"; nextSlots: Slot[] };

export type CancelResult = { status: "cancelled"; bookingId: string } | { status: "not_found" };

export interface ActorStorage {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<boolean>;
}

const DUBAI_OFFSET = 4;
const SLOT_HOURS = [10, 12, 14, 16] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function generateSlots(now: Date, daysAhead = 7): Slot[] {
	const slots: Slot[] = [];
	const nowMs = now.getTime();
	const dubaiNow = new Date(nowMs + DUBAI_OFFSET * 3_600_000);

	for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
		const d = new Date(dubaiNow.getTime() + dayOffset * 86_400_000);
		const year = d.getUTCFullYear();
		const month = d.getUTCMonth() + 1;
		const day = d.getUTCDate();

		for (const hour of SLOT_HOURS) {
			const utcMs = Date.UTC(year, month - 1, day, hour - DUBAI_OFFSET, 0, 0, 0);
			if (utcMs <= nowMs) continue;

			const id = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:00+0${DUBAI_OFFSET}:00`;
			const wd = WEEKDAYS[new Date(utcMs).getUTCDay()];
			const period = hour >= 12 ? "PM" : "AM";
			const hour12 = hour % 12 || 12;
			const voice = `${wd} ${day} ${MONTHS[month - 1]} at ${hour12} ${period}`;
			slots.push({ id, voice, utcMs });
		}
	}

	return slots;
}

const STORAGE_KEY = "bookings";

type BookingMap = Record<string, Booking>;

async function getBookings(storage: ActorStorage): Promise<BookingMap> {
	return (await storage.get<BookingMap>(STORAGE_KEY)) ?? {};
}

async function putBookings(storage: ActorStorage, bookings: BookingMap): Promise<void> {
	await storage.put(STORAGE_KEY, bookings);
}

function makeBookingId(): string {
	return `BK-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function doGetAvailableSlots(
	storage: ActorStorage,
	limit = 4,
	now: Date = new Date()
): Promise<AvailableSlotsResult> {
	const bookings = await getBookings(storage);
	const all = generateSlots(now);
	const free = all.filter((s) => !bookings[s.id]);
	return { slots: free.slice(0, limit) };
}

export async function doBookViewing(
	storage: ActorStorage,
	slotId: string,
	callerName: string,
	listingRef: string,
	now: Date = new Date()
): Promise<BookResult> {
	const all = generateSlots(now);
	const valid = all.find((s) => s.id === slotId);
	if (!valid) {
		const bookings = await getBookings(storage);
		const next = all.filter((s) => !bookings[s.id]).slice(0, 4);
		return { status: "invalid_slot", nextSlots: next };
	}

	const bookings = await getBookings(storage);
	if (bookings[slotId]) {
		const next = all.filter((s) => !bookings[s.id] && s.utcMs > now.getTime()).slice(0, 4);
		return { status: "slot_taken", slotId, nextSlots: next };
	}

	const booking: Booking = {
		bookingId: makeBookingId(),
		slotId,
		callerName,
		listingRef,
		bookedAt: now.toISOString(),
	};
	bookings[slotId] = booking;
	await putBookings(storage, bookings);
	return {
		status: "booked",
		bookingId: booking.bookingId,
		slotId,
		slotVoice: valid.voice,
	};
}

export async function doCancelViewing(storage: ActorStorage, bookingId: string): Promise<CancelResult> {
	const bookings = await getBookings(storage);
	const slotId = Object.keys(bookings).find((id) => bookings[id].bookingId === bookingId);
	if (!slotId) return { status: "not_found" };
	delete bookings[slotId];
	await putBookings(storage, bookings);
	return { status: "cancelled", bookingId };
}

export class ViewingCalendar extends StatefulActor {
	async getAvailableSlots(limit = 4): Promise<AvailableSlotsResult> {
		return doGetAvailableSlots(this.ctx.storage, limit);
	}

	async bookViewing(slotId: string, callerName: string, listingRef: string): Promise<BookResult> {
		return doBookViewing(this.ctx.storage, slotId, callerName, listingRef);
	}

	async cancelViewing(bookingId: string): Promise<CancelResult> {
		return doCancelViewing(this.ctx.storage, bookingId);
	}
}

export function agents(listings: Listing[]): string[] {
	return [...new Set(listings.map((l) => l.agent))];
}
