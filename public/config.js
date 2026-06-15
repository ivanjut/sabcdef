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
