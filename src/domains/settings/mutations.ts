import type { SupabaseClient } from "@supabase/supabase-js"
import {
  asSettingsObject,
  normalizeOperationalDayCloseTime,
  OPERATIONAL_DAY_CLOSE_TIME_KEY,
  parsePadronActividadesJson,
} from "./parse.js"
import type {
  UpdateBusinessBody,
  UpdateFiscalBody,
  UpdateImagesBody,
} from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 403 | 404 | 500 }

async function loadCurrentSettings(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("pops")
    .select("settings")
    .eq("id", popId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message, status: 500 }
  if (!data) return { ok: false, error: "No se encontró el punto.", status: 404 }
  return { ok: true, settings: asSettingsObject(data.settings) }
}

export async function updateSettingsBusiness(
  supabase: SupabaseClient,
  popId: string,
  input: UpdateBusinessBody,
): Promise<MutateResult> {
  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre del punto es obligatorio.", status: 400 }
  }

  const loaded = await loadCurrentSettings(supabase, popId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }

  const settings = { ...loaded.settings }
  settings[OPERATIONAL_DAY_CLOSE_TIME_KEY] = normalizeOperationalDayCloseTime(
    input.operationalDayCloseTime,
  )

  const { error } = await supabase
    .from("pops")
    .update({
      name,
      phone: input.phone.trim() || null,
      country: input.country.trim() || null,
      state: input.state.trim() || null,
      city: input.city.trim() || null,
      street_address: input.streetAddress.trim() || null,
      postal_code: input.postalCode.trim() || null,
      settings,
      updated_at: new Date().toISOString(),
    })
    .eq("id", popId)

  if (error) {
    return { success: false, error: error.message || "No se pudo guardar.", status: 500 }
  }
  return { success: true }
}

export async function updateSettingsFiscal(
  supabase: SupabaseClient,
  popId: string,
  isOwner: boolean,
  input: UpdateFiscalBody,
): Promise<MutateResult> {
  if (!isOwner) {
    return {
      success: false,
      error: "Solo el titular puede editar los datos fiscales.",
      status: 403,
    }
  }

  const acts = parsePadronActividadesJson(input.fiscalPadronActividadesJson)
  if (!acts.ok) return { success: false, error: acts.error, status: 400 }

  const fiscalCuitIn = input.fiscalCuit.trim()
  const fiscalRsIn = input.fiscalRazonSocial.trim()
  const fiscalIniIn = input.fiscalInicioActividadesDate.trim()
  const fiscalIbIn = input.fiscalIngresosBrutosText.trim()
  const fiscalSelId = input.fiscalActividadSeleccionadaId.trim()

  const { error } = await supabase
    .from("pops")
    .update({
      fiscal_cuit: fiscalCuitIn.length > 0 ? fiscalCuitIn : null,
      fiscal_razon_social: fiscalRsIn.length > 0 ? fiscalRsIn : null,
      fiscal_inicio_actividades_date:
        fiscalIniIn.length > 0 ? fiscalIniIn.slice(0, 10) : null,
      fiscal_ingresos_brutos_text: fiscalIbIn.length > 0 ? fiscalIbIn : null,
      fiscal_actividad_seleccionada_id: fiscalSelId.length > 0 ? fiscalSelId : null,
      fiscal_padron_actividades_json: acts.value,
      updated_at: new Date().toISOString(),
    })
    .eq("id", popId)

  if (error) {
    return { success: false, error: error.message || "No se pudo guardar.", status: 500 }
  }
  return { success: true }
}

export async function updateSettingsImages(
  supabase: SupabaseClient,
  popId: string,
  input: UpdateImagesBody,
): Promise<MutateResult> {
  const { error } = await supabase
    .from("pops")
    .update({
      image_url: input.imageUrl?.trim() || null,
      invoice_logo_url: input.invoiceLogoUrl?.trim() || null,
      background_image_url: input.backgroundImageUrl?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", popId)

  if (error) {
    return { success: false, error: error.message || "No se pudo guardar.", status: 500 }
  }
  return { success: true }
}
