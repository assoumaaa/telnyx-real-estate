"""Caller recognition, country lookup, and time/masking helpers for the
dynamic-variables webhook.

Country is derived from the phone number's dialing code (best effort from a small
table). Multi-country time zones use a representative zone; this is a known
limitation for Stage 3, where the recognized callers all live in single-zone countries.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from .callers import CALLERS


COUNTRY_CODES = [
    {"code": "971", "country": "United Arab Emirates", "timezone": "Asia/Dubai"},
    {"code": "91", "country": "India", "timezone": "Asia/Kolkata"},
    {"code": "86", "country": "China", "timezone": "Asia/Shanghai"},
    {"code": "81", "country": "Japan", "timezone": "Asia/Tokyo"},
    {"code": "82", "country": "South Korea", "timezone": "Asia/Seoul"},
    {"code": "7", "country": "Russia", "timezone": "Europe/Moscow"},
    {"code": "49", "country": "Germany", "timezone": "Europe/Berlin"},
    {"code": "33", "country": "France", "timezone": "Europe/Paris"},
    {"code": "44", "country": "United Kingdom", "timezone": "Europe/London"},
    {"code": "61", "country": "Australia", "timezone": "Australia/Sydney"},
    {"code": "55", "country": "Brazil", "timezone": "America/Sao_Paulo"},
    {"code": "1", "country": "United States", "timezone": "America/New_York"},
]

_COUNTRY_BY_CODE_LEN = sorted(COUNTRY_CODES, key=lambda e: len(e["code"]), reverse=True)


def find_caller(number):
    """Return the recognized caller dict for an E.164 number, or None."""
    if not number:
        return None
    norm = str(number).strip()
    for caller in CALLERS:
        if caller["phone"] == norm:
            return caller
    return None


def _match_country(number):
    """Return the COUNTRY_CODES entry whose dialing code prefixes the number,
    or None. Longest-prefix match so '7' does not steal '971' numbers."""
    s = str(number or "")
    if not s.startswith("+"):
        return None
    digits = s[1:]
    for entry in _COUNTRY_BY_CODE_LEN:
        if digits.startswith(entry["code"]):
            return entry
    return None


def lookup_country(number):
    """Return (country, timezone) for an E.164 number from its dialing code,
    or (None, None) if it cannot be determined."""
    entry = _match_country(number)
    return (entry["country"], entry["timezone"]) if entry else (None, None)


def mask_number(number):
    """Mask a phone number for logs.

    Keep the '+' and the dialing-code prefix (shared by millions, not personal)
    and the last two digits for light correlation; hide everything in between.
    Unknown dialing codes are masked fully. Never returns the full number.
    """
    s = str(number or "")
    if not s:
        return ""
    if not s.startswith("+"):
        s = "+" + s
    entry = _match_country(s)
    if entry is None or len(s) <= len(entry["code"]) + 1:
        return "+" + "*" * (len(s) - 1)
    head = "+" + entry["code"]
    tail = s[-2:]
    return f"{head}****{tail}"


def format_time(timezone):
    """Return the current time in an IANA timezone as e.g. '4:00 PM',
    or '' if the timezone is missing or invalid."""
    if not timezone:
        return ""
    try:
        return datetime.now(ZoneInfo(timezone)).strftime("%I:%M %p").lstrip("0")
    except Exception:
        return ""
