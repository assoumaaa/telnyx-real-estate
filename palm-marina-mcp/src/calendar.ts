import { StatefulActor } from "@telnyx/edge-runtime";

export interface Slot {
	id: string;
	voice: string;
	utcMs: number;
}

interface Booking {
	slotId: string;
	callerName: string;
	phone: string;
	listingRef: string;
	bookedAt: string;
}

export interface AvailableSlotsResult {
	slots: Slot[];
}

export type BookResult =
	| { status: "booked"; slotId: string; slotVoice: string }
	| { status: "slot_taken"; slotId: string; nextSlots: Slot[] }
	| { status: "invalid_slot"; nextSlots: Slot[] };

export type CancelResult =
	{ status: "cancelled"; slotId: string; slotVoice: string; callerName: string } | { status: "not_found" };

type BookingMap = Record<string, Booking>;

const STORAGE_KEY = "bookings";
const NEXT_SLOTS = 4;
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

export class ViewingCalendar extends StatefulActor {
	async getAvailableSlots(limit = NEXT_SLOTS): Promise<AvailableSlotsResult> {
		const bookings = await this.bookings();
		return { slots: freeSlots(bookings).slice(0, limit) };
	}

	async bookViewing(slotId: string, callerName: string, phone: string, listingRef: string): Promise<BookResult> {
		const bookings = await this.bookings();
		const slot = generateSlots(new Date()).find((s) => s.id === slotId);
		if (!slot) {
			return { status: "invalid_slot", nextSlots: freeSlots(bookings).slice(0, NEXT_SLOTS) };
		}

		if (bookings[slotId]) {
			return { status: "slot_taken", slotId, nextSlots: freeSlots(bookings).slice(0, NEXT_SLOTS) };
		}

		bookings[slotId] = { slotId, callerName, phone, listingRef, bookedAt: new Date().toISOString() };
		await this.ctx.storage.put(STORAGE_KEY, bookings);
		return { status: "booked", slotId, slotVoice: slot.voice };
	}

	/**
	 * Finds the booking on that day (e.g. "2026-10-10"; every slot id starts with its day) made from the caller's
	 * number, or under their name when they call from another phone. An empty name never matches.
	 */
	async cancelViewing(phone: string, callerName: string, date: string): Promise<CancelResult> {
		const bookings = await this.bookings();
		const booking = Object.values(bookings).find(
			(b) =>
				b.slotId.startsWith(date) &&
				(b.phone === phone || (callerName !== "" && b.callerName.toLowerCase() === callerName.toLowerCase()))
		);

		if (!booking) {
			return { status: "not_found" };
		}

		delete bookings[booking.slotId];
		await this.ctx.storage.put(STORAGE_KEY, bookings);
		return {
			status: "cancelled",
			slotId: booking.slotId,
			slotVoice: spokenTime.format(new Date(booking.slotId)),
			callerName: booking.callerName,
		};
	}

	private async bookings(): Promise<BookingMap> {
		return (await this.ctx.storage.get<BookingMap>(STORAGE_KEY)) ?? {};
	}
}

function freeSlots(bookings: BookingMap): Slot[] {
	return generateSlots(new Date()).filter((s) => !bookings[s.id]);
}
