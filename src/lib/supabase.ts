import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { getEnv } from "../env.js"

export function createUserSupabaseClient(accessToken: string): SupabaseClient {
  const env = getEnv()
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  })
}
