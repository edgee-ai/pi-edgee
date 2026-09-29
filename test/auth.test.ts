import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ readStoredCredential: () => undefined }));

const { keyExpiry, parseCallback } = await import("../src/auth.ts");

describe("parseCallback", () => {
	it("extracts the user token and profile", () => {
		expect(parseCallback("/?api_key=tok_123&email=8098%40edgee.ai&user_id=42999158-ae9f-5b44-8834-27675aacf427")).toEqual({
			userToken: "tok_123",
			email: "8098@edgee.ai",
			userId: "42999158-ae9f-5b44-8834-27675aacf427",
		});
	});

	it("reports a browser-side cancel", () => {
		expect(() => parseCallback("/?error=access_denied")).toThrow(/cancelled/);
	});

	it("rejects a callback without a token", () => {
		expect(() => parseCallback("/?email=x")).toThrow(/api_key/);
	});
});

describe("keyExpiry", () => {
	const now = Date.parse("2026-09-24T12:00:00Z");
	const week = 7 * 24 * 60 * 60 * 1000;

	it("treats the zero time as never expiring, revalidating weekly", () => {
		expect(keyExpiry("0001-01-01T00:00:00Z", now)).toBe(now + week);
		expect(keyExpiry(undefined, now)).toBe(now + week);
	});

	it("uses a real expiry when it comes first", () => {
		expect(keyExpiry("2026-09-25T12:00:00Z", now)).toBe(Date.parse("2026-09-25T12:00:00Z"));
	});

	it("caps distant expiries at the revalidation window", () => {
		expect(keyExpiry("2030-01-01T00:00:00Z", now)).toBe(now + week);
	});
});
