// Scope-alignment UI only: keep stored records, history and server operations intact.
// These actions must not become visible just because the release phase changes.
export const SCOPED_UI_ACTIONS = Object.freeze({
  participationCancellation: false,
  productDeletion: false,
});
