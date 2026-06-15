// Creates the Supabase browser client from the values in config.js.
// The SDK is loaded as an ES module straight from a CDN — no build step.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// True once real credentials have been filled into config.js. The app uses this
// to gracefully disable the forum (rather than throw) when it's not configured.
export const isConfigured =
  !!SUPABASE_URL &&
  !!SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes("YOUR-") &&
  !SUPABASE_ANON_KEY.includes("YOUR-");

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;
