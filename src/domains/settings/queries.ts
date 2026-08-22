import type { SupabaseClient } from "@supabase/supabase-js"
import { mapPopSettingsForm } from "./parse.js"
import type { PopSettingsData } from "./schema.js"

const SETTINGS_SELECT = `
  name,
  phone,
  country,
  state,
  city,
  street_address,
  postal_code,
  image_url,
  invoice_logo_url,
  background_image_url,
  fiscal_cuit,
  fiscal_razon_social,
  fiscal_inicio_actividades_date,
  fiscal_ingresos_brutos_text,
  fiscal_padron_actividades_json,
  fiscal_actividad_seleccionada_id,
  fiscal_padron_synced_at,
  settings
`

export async function getPopSettings(
  supabase: SupabaseClient,
  popId: string,
  isOwner: boolean,
): Promise<
  | { success: true; data: PopSettingsData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("pops")
    .select(SETTINGS_SELECT)
    .eq("id", popId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "No se encontraron los ajustes.", status: 404 }
  }

  return {
    success: true,
    data: {
      form: mapPopSettingsForm(data as Record<string, unknown>),
      isOwner,
    },
  }
}
