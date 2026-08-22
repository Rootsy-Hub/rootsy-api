import type { SupabaseClient } from "@supabase/supabase-js"

const SERVICE_IMAGE_STORAGE_BUCKET = "rootsy_catalog_public"
const MAX_BYTES = 5 * 1024 * 1024

function buildServiceImageFileName(): string {
  return `${crypto.randomUUID()}.webp`
}

function buildServiceImageStoragePath(popId: string, fileName: string): string {
  return `${popId}/services/${fileName}`
}

export async function uploadServiceImage(
  supabase: SupabaseClient,
  popId: string,
  file: File,
): Promise<
  | { success: true; data: { imageUrl: string } }
  | { success: false; error: string; status: 400 | 500 }
> {
  if (file.size <= 0) {
    return { success: false, error: "Elegí una imagen para subir.", status: 400 }
  }
  if (file.type !== "image/webp") {
    return { success: false, error: "La imagen debe estar en formato WebP.", status: 400 }
  }
  if (file.size > MAX_BYTES) {
    return {
      success: false,
      error: "La imagen comprimida supera el límite de 5 MB.",
      status: 400,
    }
  }

  const fileName = buildServiceImageFileName()
  const storagePath = buildServiceImageStoragePath(popId, fileName)
  const bytes = Buffer.from(await file.arrayBuffer())

  const { error: uploadError } = await supabase.storage
    .from(SERVICE_IMAGE_STORAGE_BUCKET)
    .upload(storagePath, bytes, {
      contentType: "image/webp",
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
    .from(SERVICE_IMAGE_STORAGE_BUCKET)
    .getPublicUrl(storagePath)

  const imageUrl = publicUrlData.publicUrl?.trim()
  if (!imageUrl) {
    return { success: false, error: "No se pudo obtener la URL pública.", status: 500 }
  }

  return { success: true, data: { imageUrl } }
}
