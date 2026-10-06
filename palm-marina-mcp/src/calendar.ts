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

const DUBAI_OFFSET_HOURS = 4;
const SLOT_HOURS = [10, 12, 14, 16];
const spokenTime = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Asia/Dubai",
	weekday: "long",
	day: "numeric",
	month: "long",
	hour: "numeric",
	hour12: true,
});

export function generateSlots(now: Date, daysAhead = 7): Slot[] {
	const offsetMs = DUBAI_OFFSET_HOURS * 3_600_000;
	const dubaiToday = new Date(now.getTime() + offsetMs);
	const slots: Slot[] = [];

	for (let day = 0; day <= daysAhead; day++) {
		for (const hour of SLOT_HOURS) {
			const utcMs = Date.UTC(
				dubaiToday.getUTCFullYear(),
				dubaiToday.getUTCMonth(),
				dubaiToday.getUTCDate() + day,
				hour - DUBAI_OFFSET_HOURS
			);
			if (utcMs <= now.getTime()) {
				continue;
			}

			const id = new Date(utcMs + offsetMs).toISOString().slice(0, 16) + "+04:00";
			slots.push({ id, voice: spokenTime.format(utcMs), utcMs });
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
		if (!slotId) {
			return { status: "not_found" };
		}

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
