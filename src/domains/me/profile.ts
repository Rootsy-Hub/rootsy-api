import type { SupabaseClient } from "@supabase/supabase-js"
import type { MeProfile } from "./schema.js"

function metaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = meta?.[key]
  return typeof v === "string" ? v.trim() : ""
}

export async function getMeProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<
  { success: true; data: MeProfile } | { success: false; error: string }
> {
  const [{ data: row, error }, { data: authData }, { data: canCreate }] =
    await Promise.all([
      supabase
        .from("users")
        .select("first_name, last_name, image_url")
        .eq("id", userId)
        .maybeSingle(),
      supabase.auth.getUser(),
      supabase.rpc("can_user_create_pop", { user_id: userId }),
    ])

  if (error) return { success: false, error: error.message }

  const meta = (authData.user?.user_metadata ?? {}) as Record<string, unknown>
  const emailFallback = authData.user?.email?.split("@")[0] || "Usuario"

  const firstName = String(row?.first_name ?? "").trim()
  const lastName = String(row?.last_name ?? "").trim()
  const fromRow = `${firstName} ${lastName}`.trim()
  const fullName =
    fromRow ||
    metaString(meta, "full_name") ||
    metaString(meta, "name") ||
    metaString(meta, "first_name") ||
    emailFallback

  const imageFromRow =
    typeof row?.image_url === "string" ? row.image_url.trim() : ""
  const imageUrl = imageFromRow || metaString(meta, "avatar_url") || null

  return {
    success: true,
    data: {
      id: userId,
      firstName: firstName || fullName,
      lastName,
      fullName,
      imageUrl,
      canCreatePop: canCreate === true,
    },
  }
}
