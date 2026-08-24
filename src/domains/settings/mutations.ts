import type { SupabaseClient } from "@supabase/supabase-js"
import { auditedUpdate } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import {
  asSettingsObject,
  normalizeOperationalDayCloseTime,
  OPERATIONAL_DAY_CLOSE_TIME_KEY,
  parsePadronActividadesJson,
} from "./parse.js"
import { mergePatch } from "../../lib/patchBody.js"
import { getPopSettings } from "./queries.js"
import type {
  PatchBusinessBody,
  PatchFiscalBody,
  PatchImagesBody,
  PopSettingsForm,
  UpdateBusinessBody,
  UpdateFiscalBody,
  UpdateImagesBody,
} from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 403 | 404 | 500 }

async function loadPopRow(
  supabase: SupabaseClient,
  popId: string,
  columns: string,
): Promise<
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("pops")
    .select(columns)
    .eq("id", popId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message, status: 500 }
  if (!data) return { ok: false, error: "No se encontró el punto.", status: 404 }
  return { ok: true, row: data as unknown as Record<string, unknown> }
}

function formToBusinessBody(form: PopSettingsForm): UpdateBusinessBody {
  return {
    name: form.name,
    phone: form.phone,
    country: form.country,
    state: form.state,
    city: form.city,
    streetAddress: form.streetAddress,
    postalCode: form.postalCode,
    operationalDayCloseTime: form.operationalDayCloseTime,
  }
}

function formToFiscalBody(form: PopSettingsForm): UpdateFiscalBody {
  return {
    fiscalCuit: form.fiscalCuit,
    fiscalRazonSocial: form.fiscalRazonSocial,
    fiscalInicioActividadesDate: form.fiscalInicioActividadesDate,
    fiscalIngresosBrutosText: form.fiscalIngresosBrutosText,
    fiscalPadronActividadesJson: form.fiscalPadronActividadesJson,
    fiscalActividadSeleccionadaId: form.fiscalActividadSeleccionadaId,
  }
}

function formToImagesBody(form: PopSettingsForm): UpdateImagesBody {
  return {
    imageUrl: form.imageUrl || null,
    invoiceLogoUrl: form.invoiceLogoUrl || null,
    backgroundImageUrl: form.backgroundImageUrl || null,
  }
}

export async function updateSettingsBusiness(
  supabase: SupabaseClient,
  popId: string,
  patch: PatchBusinessBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getPopSettings(supabase, popId, false)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(formToBusinessBody(current.data.form), patch)

  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre del punto es obligatorio.", status: 400 }
  }

  const loaded = await loadPopRow(
    supabase,
    popId,
    "name, phone, country, state, city, street_address, postal_code, settings",
  )
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }

  const settings = { ...asSettingsObject(loaded.row.settings) }
  settings[OPERATIONAL_DAY_CLOSE_TIME_KEY] = normalizeOperationalDayCloseTime(
    input.operationalDayCloseTime,
  )

  const updateRow = {
    name,
    phone: input.phone.trim() || null,
    country: input.country.trim() || null,
    state: input.state.trim() || null,
    city: input.city.trim() || null,
    street_address: input.streetAddress.trim() || null,
    postal_code: input.postalCode.trim() || null,
    settings,
    updated_at: new Date().toISOString(),
  }
  const applied = await auditedUpdate(supabase, {
    kind: "settings.patch",
    table: "pops",
    id: popId,
    row: updateRow,
    ctx: audit,
    popId,
    previous: loaded.row,
    next: { ...loaded.row, ...updateRow },
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error || "No se pudo guardar.",
      status: applied.status,
    }
  }
  return { success: true }
}

export async function updateSettingsFiscal(
  supabase: SupabaseClient,
  popId: string,
  patch: PatchFiscalBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getPopSettings(supabase, popId, false)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(formToFiscalBody(current.data.form), patch)

  const acts = parsePadronActividadesJson(input.fiscalPadronActividadesJson)
  if (!acts.ok) return { success: false, error: acts.error, status: 400 }

  const fiscalCuitIn = input.fiscalCuit.trim()
  const fiscalRsIn = input.fiscalRazonSocial.trim()
  const fiscalIniIn = input.fiscalInicioActividadesDate.trim()
  const fiscalIbIn = input.fiscalIngresosBrutosText.trim()
  const fiscalSelId = input.fiscalActividadSeleccionadaId.trim()

  const loaded = await loadPopRow(
    supabase,
    popId,
    "fiscal_cuit, fiscal_razon_social, fiscal_inicio_actividades_date, fiscal_ingresos_brutos_text, fiscal_actividad_seleccionada_id, fiscal_padron_actividades_json",
  )
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }

  const updateRow = {
    fiscal_cuit: fiscalCuitIn.length > 0 ? fiscalCuitIn : null,
    fiscal_razon_social: fiscalRsIn.length > 0 ? fiscalRsIn : null,
    fiscal_inicio_actividades_date:
      fiscalIniIn.length > 0 ? fiscalIniIn.slice(0, 10) : null,
    fiscal_ingresos_brutos_text: fiscalIbIn.length > 0 ? fiscalIbIn : null,
    fiscal_actividad_seleccionada_id: fiscalSelId.length > 0 ? fiscalSelId : null,
    fiscal_padron_actividades_json: acts.value,
    updated_at: new Date().toISOString(),
  }
  const applied = await auditedUpdate(supabase, {
    kind: "settings.patch",
    table: "pops",
    id: popId,
    row: updateRow,
    ctx: audit,
    popId,
    previous: loaded.row,
    next: { ...loaded.row, ...updateRow },
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error || "No se pudo guardar.",
      status: applied.status,
    }
  }
  return { success: true }
}

export async function updateSettingsImages(
  supabase: SupabaseClient,
  popId: string,
  patch: PatchImagesBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getPopSettings(supabase, popId, false)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(formToImagesBody(current.data.form), patch)

  const loaded = await loadPopRow(
    supabase,
    popId,
    "image_url, invoice_logo_url, background_image_url",
  )
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }

  const updateRow = {
    image_url: input.imageUrl?.trim() || null,
    invoice_logo_url: input.invoiceLogoUrl?.trim() || null,
    background_image_url: input.backgroundImageUrl?.trim() || null,
    updated_at: new Date().toISOString(),
  }
  const applied = await auditedUpdate(supabase, {
    kind: "settings.patch",
    table: "pops",
    id: popId,
    row: updateRow,
    ctx: audit,
    popId,
    previous: loaded.row,
    next: { ...loaded.row, ...updateRow },
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error || "No se pudo guardar.",
      status: applied.status,
    }
  }
  return { success: true }
}
