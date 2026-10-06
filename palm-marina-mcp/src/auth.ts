/** The reason is logged to diagnose failures, so it must never include the token itself. */
export function authFailureReason(req: Request): string | null {
	// Edge injects every secret as an environment variable; it is never a property on env.
	const expected = process.env.MCP_TOKEN ?? "";
	if (!expected) {
		return "MCP_TOKEN secret not set";
	}

	const header = req.headers.get("Authorization");
	if (header === null) {
		return "no authorization header";
	}

	const spaceIdx = header.indexOf(" ");
	const scheme = spaceIdx >= 0 ? header.slice(0, spaceIdx) : header;
	if (scheme.toLowerCase() !== "bearer") {
		// Only the shape: without "Bearer " the header may be the raw token.
		return `not a Bearer header (${header.length} chars, ${spaceIdx >= 0 ? "has" : "no"} space)`;
	}

	const token = spaceIdx >= 0 ? header.slice(spaceIdx + 1) : "";
	if (!timingSafeEqual(token, expected)) {
		return `token mismatch (sent ${token.length} chars, expected ${expected.length} chars)`;
	}
	return null;
}

/** Compares in constant time, so response timing doesn't reveal how much of a guess was right. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}
