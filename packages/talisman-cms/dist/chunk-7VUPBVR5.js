// src/auth/collection-access.ts
function canAccessCollection(collection, user, operation) {
  return collection.access?.[operation] !== "admin" || user.role === "admin";
}

export {
  canAccessCollection
};
