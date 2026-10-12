/**
 * Small environment-config helpers that gate optional features.
 */

/** Whether catalog GET endpoints are publicly viewable without a session. */
export function isCatalogPublic(): boolean {
  return process.env.CATALOG_PUBLIC === "true"
}
