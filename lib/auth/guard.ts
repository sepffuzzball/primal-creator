/**
 * Authorization guards applied at the route boundary.
 *
 * These functions resolve the session and throw the appropriate ApiError when
 * the caller is not authenticated / not an admin / not the owner of a resource.
 * They never silently return a default - every protected route must opt in, so an
 * unauthenticated request can never read or mutate another user's data.
 *
 * CSRF origin defence: every cookie-authenticated *unsafe* (state-changing)
 * method must carry an `Origin` header that exactly matches the configured
 * `APP_ORIGIN`, or, when `APP_ORIGIN` is unset, the expected origin resolved from
 * the request (the request's own origin, or - only when `TRUST_PROXY_HEADERS=true`
 * - the origin reconstructed from `X-Forwarded-Proto` / `X-Forwarded-Host`).
 * There is no suffix/subdomain wildcard - the match is exact, so a sibling
 * subdomain is correctly rejected. The check runs BEFORE the session lookup, so a
 * cross-origin request is rejected without touching the database. Safe methods
 * (GET/HEAD/OPTIONS) are exempt.
 */

import { getSessionUser, type SessionUser } from "@/lib/auth/session"
import { forbidden, unauthorized } from "@/lib/server/errors"

/** Method names that never change state and therefore need no CSRF check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * The origin a state-changing request must come from, resolved in priority
 * order:
 *
 * 1. `APP_ORIGIN` when set. This is the real browser origin and the highest
 *    priority source of truth; it is normalized only by stripping a trailing
 *    slash and is never ignored, even if forwarded headers disagree.
 * 2. When `APP_ORIGIN` is unset and `TRUST_PROXY_HEADERS=true`, the origin
 *    reconstructed from the request's `X-Forwarded-Proto` and
 *    `X-Forwarded-Host` headers. This is the ONLY case forwarded headers are
 *    consulted. The pair must be unambiguous - exactly one value each, a scheme
 *    of http/https, and a DNS host or bracketed IPv6 literal with (optionally) a
 *    valid port - otherwise the request FAILS CLOSED with 403 `bad_origin`
 *    rather than falling back to the un-proxied request URL.
 * 3. Otherwise the request's own origin (`new URL(req.url).origin`), which is
 *    correct only for a direct, non-proxied deployment. Forwarded headers are
 *    ignored in this mode.
 */
function expectedOrigin(req: Request): string {
  const configured = process.env.APP_ORIGIN
  if (configured) return configured.replace(/\/+$/, "")
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    return reconstructedTrustedOrigin(req)
  }
  return new URL(req.url).origin
}

/**
 * Rebuild the public browser origin from forwarded headers. Both headers must be
 * present, each hold exactly one value (no comma-separated lists), and carry no
 * whitespace; the scheme must be exactly `https` or `http`, and the host must be
 * a DNS name or a bracketed IPv6 literal with an optional, valid port. Anything
 * else - a missing header, a comma list, whitespace, userinfo credentials, a
 * path/query/fragment, or an invalid port - throws 403 `bad_origin`. The result
 * is canonicalized through `URL.origin` and compared exactly against `Origin`.
 *
 * Whitespace note: the `Headers`/`Request` layer trims leading/trailing HTTP
 * whitespace (OWS) from a header value before the guard reads it, so a proxy
 * that wraps the value in spaces (e.g. `" https"`) is harmless - the value is
 * already normalized. Only whitespace *embedded* in the value (e.g. `"ht tps"`,
 * `"a.example.com "` interior) is observable here and rejected. The proxy must
 * overwrite BOTH `X-Forwarded-Proto` and `X-Forwarded-Host` on every request so
 * the app never sees a stale/absent pair.
 */
function reconstructedTrustedOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto")
  const host = req.headers.get("x-forwarded-host")
  if (!isSingleForwardedValue(proto) || !isSingleForwardedValue(host)) {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }
  if (proto !== "https" && proto !== "http") {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }
  const canonicalHost = canonicalForwardedHost(host)
  try {
    return new URL(`${proto}://${canonicalHost}`).origin
  } catch {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }
}

/** True only for a present, non-empty, single (comma-free and whitespace-free) value. */
function isSingleForwardedValue(value: string | null): value is string {
  if (value == null) return false
  if (value.includes(",")) return false
  if (/\s/.test(value)) return false
  return value.length > 0
}

/**
 * Validate a forwarded `Host` value and return it in a form safe to pass to
 * `new URL`. Rejects userinfo credentials, a path/query/fragment, an unbracketed
 * IPv6 literal, and an invalid port.
 */
function canonicalForwardedHost(host: string): string {
  if (/[@/?]|#/.test(host)) {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }

  if (host.startsWith("[")) {
    const close = host.indexOf("]")
    if (close === -1) {
      throw forbidden("bad_origin", "Cross-origin request rejected")
    }
    const literal = host.slice(1, close)
    if (!/^[0-9a-fA-F:.]+$/.test(literal) || !literal.includes(":")) {
      throw forbidden("bad_origin", "Cross-origin request rejected")
    }
    const rest = host.slice(close + 1)
    if (rest === "") return host
    if (rest.startsWith(":") && isValidPort(rest.slice(1))) return host
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }

  if (host.includes("[") || host.includes("]")) {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }

  const colons = (host.match(/:/g) ?? []).length

  let name = host
  if (colons === 1) {
    const idx = host.lastIndexOf(":")
    name = host.slice(0, idx)
    const port = host.slice(idx + 1)
    if (!isValidPort(port)) {
      throw forbidden("bad_origin", "Cross-origin request rejected")
    }
  } else if (colons > 1) {
    // An unbracketed IPv6 literal (e.g. `2001:db8::1`) is ambiguous with a port;
    // require the bracketed form.
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }

  if (!isDnsHost(name)) {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }
  return host
}

/** A port is valid when it is a 1-65535 decimal integer (no empty, alpha or >65535). */
function isValidPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

/** A DNS hostname: dot-separated labels of letters/digits/hyphens with no empty or edge-hyphen label. */
function isDnsHost(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false
  return name
    .split(".")
    .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
}

/**
 * Assert that an unsafe request originates from the same origin. Throws a 403
 * `bad_origin` when the `Origin` header is missing, null or mismatched. Safe
 * methods pass through without any header requirement.
 */
export function assertOrigin(req: Request): void {
  const method = req.method.toUpperCase()
  if (SAFE_METHODS.has(method)) return
  const origin = req.headers.get("origin")
  const expected = expectedOrigin(req)
  if (!origin || origin !== expected) {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }
}

export async function requireUser(req: Request): Promise<SessionUser> {
  assertOrigin(req)
  const user = await getSessionUser(req)
  if (!user) throw unauthorized("unauthorized", "Not authenticated")
  return user
}

export async function requireAdmin(req: Request): Promise<SessionUser> {
  const user = await requireUser(req)
  if (!user.isAdmin) throw forbidden("forbidden", "Admin role required")
  return user
}

/**
 * Assert that a character belongs to the requesting user, or that the requestor
 * is an admin. Throws a 403/404 when access is denied. Only the owner or an
 * admin may read/mutate a character.
 */
export function assertCharacterAccess(
  character: { ownerId: string },
  user: SessionUser
): void {
  if (user.isAdmin) return
  if (character.ownerId === user.id) return
  throw forbidden("forbidden", "You do not own this character")
}
