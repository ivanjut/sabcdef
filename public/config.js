// ── Supabase connection ────────────────────────────────────────────────────
// Fill these in from your Supabase project: Dashboard → Project Settings → API.
//
// The "anon" (public) key is DESIGNED to ship in the browser. It only grants
// what your Row Level Security policies allow — see supabase/schema.sql, which
// permits reading + posting comments and voting via a controlled function, and
// nothing else. Do NOT put the "service_role" key here; that one is secret.
//
// Until these are set to real values, the app still works (tier list, daily
// category, theme) and the discussion section shows an "offline" notice.

export const SUPABASE_URL = "https://jefuceganmxzvdzzmnkz.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplZnVjZWdhbm14enZkenptbmt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NTkzNzEsImV4cCI6MjA5NzEzNTM3MX0.Nz_jgBTZ0VygOGG6Llgr_dr51KEEXRUugH5qygd_Enc";

// ── Web Push (notifications) ────────────────────────────────────────────────
// The VAPID *public* key for push notifications. Like the anon key above, this
// one is meant to ship in the browser — it only identifies your push server to
// the browser's push service; the matching private key stays secret in the
// Supabase Edge Function (see supabase/functions/send-push). Generate a pair
// once with:  npx web-push generate-vapid-keys
// then paste the public key here and set the private key as a function secret.
// Leave it as "YOUR-VAPID-PUBLIC-KEY" to keep notifications turned off.
export const VAPID_PUBLIC_KEY = "BEzOT-nav4hY3wI5e48xrbIh0PJO2Pv6u7scE3MUIiNSA9cQG_8yBrshSqamnG7lSw6r3oRqEnuxXPjtakZ7WBU";
