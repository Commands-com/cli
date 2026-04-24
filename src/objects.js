/**
 * Shared runtime object guard.
 *
 * Keep object-shape checks behind this stable utility so callers do not grow
 * subtly different definitions of "record enough for property access".
 * This intentionally accepts only plain objects and null-prototype records,
 * not arbitrary object instances.
 */
export function isObjectRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
