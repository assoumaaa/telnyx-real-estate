"""Hardcoded fictional returning callers for Palm & Marina Realty.

These are the numbers the concierge recognizes. Every other number is a new caller.
This is a static list for Stage 3; KV (and remembering new callers across calls)
comes in a later stage.
"""

CALLERS = [
    {
        "phone": "+447911123456",
        "name": "James",
        "last_time_note": (
            "Looking for a 2-bedroom in Dubai Marina to buy, up to AED 2.5 million; booked a viewing last time."
        ),
    },
    {
        "phone": "+919876500000",
        "name": "Priya",
        "last_time_note": "Wanted a 1-bedroom rental in Dubai Marina, annual rent up to AED 100,000.",
    },
    {
        "phone": "+74950000000",
        "name": "Dmitri",
        "last_time_note": "Interested in a 4-bedroom villa on Palm Jumeirah.",
    },
    {
        "phone": "+8613800000000",
        "name": "Wei",
        "last_time_note": "Asked about buying a 3-bedroom in Downtown Dubai, up to AED 4.5 million.",
    },
]
