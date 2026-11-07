/** Session policy. Dependency-free so the edge-safe proxy can import it. */
export const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
/** Device tokens (API) last this long, renewed while in use. */
export const DEVICE_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
