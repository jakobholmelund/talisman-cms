// src/order-reference.ts
function orderReference(id) {
  const suffix = id.match(/-([0-9a-f]{12})$/i)?.[1];
  return suffix ? `TAL-${suffix.toUpperCase()}` : id;
}
function customerOrderDestination(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}
function customerOrderPath(id) {
  return `/checkout/success?order=${encodeURIComponent(id)}`;
}

export {
  orderReference,
  customerOrderDestination,
  customerOrderPath
};
