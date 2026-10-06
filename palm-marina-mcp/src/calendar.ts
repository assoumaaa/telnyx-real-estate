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
const NEXT_SLOTS = 4;

type BookingMap = Record<string, Booking>;

function makeBookingId(): string {
	return `BK-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class ViewingCalendar extends StatefulActor {
	async getAvailableSlots(limit = NEXT_SLOTS): Promise<AvailableSlotsResult> {
		const bookings = await this.bookings();
		return { slots: freeSlots(bookings).slice(0, limit) };
	}

	async bookViewing(slotId: string, callerName: string, listingRef: string): Promise<BookResult> {
		const bookings = await this.bookings();
		const slot = generateSlots(new Date()).find((s) => s.id === slotId);
		if (!slot) {
			return { status: "invalid_slot", nextSlots: freeSlots(bookings).slice(0, NEXT_SLOTS) };
		}
		// Safe without locks: the platform runs one call at a time per actor instance (one per agent).
		if (bookings[slotId]) {
			return { status: "slot_taken", slotId, nextSlots: freeSlots(bookings).slice(0, NEXT_SLOTS) };
		}

		const bookingId = makeBookingId();
		bookings[slotId] = { bookingId, slotId, callerName, listingRef, bookedAt: new Date().toISOString() };
		await this.ctx.storage.put(STORAGE_KEY, bookings);
		return { status: "booked", bookingId, slotId, slotVoice: slot.voice };
	}

	async cancelViewing(bookingId: string): Promise<CancelResult> {
		const bookings = await this.bookings();
		const slotId = Object.keys(bookings).find((id) => bookings[id].bookingId === bookingId);
		if (!slotId) return { status: "not_found" };
		delete bookings[slotId];
		await this.ctx.storage.put(STORAGE_KEY, bookings);
		return { status: "cancelled", bookingId };
	}

	private async bookings(): Promise<BookingMap> {
		return (await this.ctx.storage.get<BookingMap>(STORAGE_KEY)) ?? {};
	}
}

function freeSlots(bookings: BookingMap): Slot[] {
	return generateSlots(new Date()).filter((s) => !bookings[s.id]);
}

export function agents(listings: Listing[]): string[] {
	return [...new Set(listings.map((l) => l.agent))];
}
