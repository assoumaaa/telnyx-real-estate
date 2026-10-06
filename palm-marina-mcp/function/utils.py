"""Search and voice-formatting helpers for Palm & Marina Realty listings."""

from .listings import LISTINGS

AREAS = sorted({listing["area"] for listing in LISTINGS})


def filter_listings(purpose=None, area=None, bedrooms=None, budget=None):
    return [
        listing
        for listing in LISTINGS
        if (not purpose or listing["purpose"] == purpose)
        and (not area or listing["area"].lower() == area.lower().strip())
        and (bedrooms is None or listing["bedrooms"] == bedrooms)
        and (budget is None or listing["price_aed"] <= budget)
    ]


def format_for_voice(matches):
    """Say how many properties match and describe up to 3 of them."""
    if not matches:
        return (
            "I'm sorry, I couldn't find any properties matching those criteria. "
            "Would you like me to widen the search, for example by raising the budget or trying a different area?"
        )

    shown = matches[:3]
    if len(matches) == 1:
        intro = "I found one matching property."
    elif len(matches) <= 3:
        intro = f"I found {len(matches)} matching properties."
    else:
        intro = f"I found {len(matches)} matching properties. Here are the first {len(shown)}."

    parts = [intro] + [
        f"Option {i}: {_describe(listing)}" for i, listing in enumerate(shown, start=1)
    ]
    return " ".join(parts)


def _format_amount(amount):
    if amount >= 1_000_000:
        return f"{amount / 1_000_000:g} million"
    if amount >= 1_000:
        return f"{amount / 1_000:g} thousand"
    return str(amount)


def _describe(listing):
    rooms = "studio" if listing["bedrooms"] == 0 else f"{listing['bedrooms']} bedroom"
    amount = _format_amount(listing["price_aed"])
    price = (
        f"priced at {amount} dirhams"
        if listing["purpose"] == "buy"
        else f"rented at {amount} dirhams per year"
    )
    return (
        f"a {rooms} {listing['type']} in {listing['area']}, {listing['size_sqft']} square feet, {price}. "
        f"It has {', '.join(listing['features'][:3])}."
    )
