import type { SupabaseClient } from "@supabase/supabase-js"
import type { SettingsImageKind } from "./schema.js"

const POP_IMAGE_STORAGE_BUCKET = "rootsy_catalog_public"
const MAX_BYTES = 5 * 1024 * 1024

function buildFileName(kind: SettingsImageKind): string {
  const ext = kind === "ticket-logo" ? "png" : "webp"
  return `${crypto.randomUUID()}.${ext}`
}

function buildStoragePath(
  popId: string,
  kind: SettingsImageKind,
  fileName: string,
): string {
  return `${popId}/settings/${kind}/${fileName}`
}

export async function uploadSettingsImage(
  supabase: SupabaseClient,
  popId: string,
  kind: SettingsImageKind,
  file: File,
): Promise<
  | { success: true; data: { imageUrl: string } }
  | { success: false; error: string; status: 400 | 500 }
> {
  if (file.size <= 0) {
    return { success: false, error: "Elegí una imagen para subir.", status: 400 }
  }

  const expectedType = kind === "ticket-logo" ? "image/png" : "image/webp"
  if (file.type !== expectedType) {
    return {
      success: false,
      error:
        kind === "ticket-logo"
          ? "El logo de ticket debe estar en formato PNG."
          : "La imagen debe estar en formato WebP.",
      status: 400,
    }
  }
  if (file.size > MAX_BYTES) {
    return {
      success: false,
      error: "La imagen comprimida supera el límite de 5 MB.",
      status: 400,
    }
  }

  const fileName = buildFileName(kind)
  const storagePath = buildStoragePath(popId, kind, fileName)
  const bytes = Buffer.from(await file.arrayBuffer())

  const { error: uploadError } = await supabase.storage
    .from(POP_IMAGE_STORAGE_BUCKET)
    .upload(storagePath, bytes, {
      contentType: expectedType,
      cacheControl: "31536000",
      upsert: false,
    })

  if (uploadError) {
    return {
      success: false,
      error: uploadError.message || "No se pudo subir la imagen.",
      status: 500,
    }
  }

  const { data: publicUrlData } = supabase.storage
    .from(POP_IMAGE_STORAGE_BUCKET)
    .getPublicUrl(storagePath)

  const imageUrl = publicUrlData.publicUrl?.trim()
  if (!imageUrl) {
    return { success: false, error: "No se pudo obtener la URL pública.", status: 500 }
  }

  return { success: true, data: { imageUrl } }
}
