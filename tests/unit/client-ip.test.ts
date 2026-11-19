import { describe, expect, it } from "vitest";
import { clientIpFrom } from "@/server/auth/client-ip";

const withFor = (value?: string) => new Headers(value === undefined ? {} : { "x-forwarded-for": value });

describe("clientIpFrom", () => {
  it("takes the address the proxy appended, not one the client wrote", () => {
    // The client sent "X-Forwarded-For: 1.2.3.4"; the proxy appended the real address.
    expect(clientIpFrom(withFor("1.2.3.4, 41.66.7.8"), {})).toBe("41.66.7.8");
  });

  it("reads a single entry (no proxy: Next.js fills it from the socket)", () => {
    expect(clientIpFrom(withFor("127.0.0.1"), {})).toBe("127.0.0.1");
    expect(clientIpFrom(withFor("::1"), {})).toBe("::1");
  });

  it("counts back past each trusted proxy", () => {
    const env = { TRUSTED_PROXY_HOPS: "2" };
    expect(clientIpFrom(withFor("6.6.6.6, 41.66.7.8, 10.0.0.2"), env)).toBe("41.66.7.8");
    // Fewer entries than proxies: the request did not come through them, so no address is trusted.
    expect(clientIpFrom(withFor("41.66.7.8"), env)).toBeNull();
  });

  it("ignores X-Real-IP and anything that is not an address", () => {
    expect(clientIpFrom(new Headers({ "x-real-ip": "1.2.3.4" }), {})).toBeNull();
    expect(clientIpFrom(withFor("not-an-ip"), {})).toBeNull();
    expect(clientIpFrom(withFor(""), {})).toBeNull();
    expect(clientIpFrom(withFor(), {})).toBeNull();
  });

  it("refuses a nonsensical setting", () => {
    expect(() => clientIpFrom(withFor("1.2.3.4"), { TRUSTED_PROXY_HOPS: "0" })).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(() => clientIpFrom(withFor("1.2.3.4"), { TRUSTED_PROXY_HOPS: "abc" })).toThrow(
      /TRUSTED_PROXY_HOPS/,
    );
  });
});
