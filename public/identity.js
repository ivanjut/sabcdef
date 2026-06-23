// A stable, anonymous per-device id, minted on first use and kept in
// localStorage. It's the same trust model as the rest of the app (no accounts):
// the id lets a device change/withdraw its suggestion reactions, lets replies be
// attributed back to the device that posted the parent comment (for "reply"
// notifications), and ties a push subscription to its device. It is not a
// secret and is not authenticated — it only distinguishes one browser profile
// from another.
//
// The value is JSON-encoded to match how app.js's `store` helper reads/writes
// every other namespaced key, so both modules see the same id.

const KEY = "sabcdef:voterId";

export function getDeviceId() {
  try {
    let id = JSON.parse(localStorage.getItem(KEY));
    if (!id) {
      id =
        (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
        `v_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem(KEY, JSON.stringify(id));
    }
    return id;
  } catch {
    // Private mode / storage blocked: fall back to a volatile per-session id so
    // the app still functions (it just won't persist across reloads).
    return `v_${Math.random().toString(36).slice(2)}`;
  }
}
