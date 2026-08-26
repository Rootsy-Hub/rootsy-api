import type { SupabaseClient } from "@supabase/supabase-js"
import {
  DEFAULT_SALE_SITE_ID,
  type SaleComprobanteOption,
  type SaleComprobantesData,
} from "./schema.js"

const SALE_PICKER_ARCA = [
  { label: "Factura B", arcaCbteTipo: 6, emisor: "responsable_inscripto" },
  { label: "Factura A", arcaCbteTipo: 1, emisor: "responsable_inscripto" },
  { label: "Factura C", arcaCbteTipo: 11, emisor: "monotributo" },
] as const

function hasValidFiscalCuit(raw: unknown): boolean {
  const digits = String(raw ?? "").replace(/\D/g, "")
  return digits.length === 11
}

function emisorIvaFromSettings(
  settings: unknown,
  validCuit: boolean,
): "responsable_inscripto" | "monotributo" {
  if (!validCuit) return "responsable_inscripto"
  if (settings == null || typeof settings !== "object") {
    return "responsable_inscripto"
  }
  const raw = (settings as Record<string, unknown>).fiscal_iva_condition
  return raw === "monotributo" ? "monotributo" : "responsable_inscripto"
}

function emisorIvaLabel(
  emisor: "responsable_inscripto" | "monotributo",
  validCuit: boolean,
): string {
  if (!validCuit) return "—"
  return emisor === "monotributo" ? "Monotributo" : "IVA Responsable Inscripto"
}

function textOrNull(raw: unknown): string | null {
  const value = String(raw ?? "").trim()
  return value || null
}

function popAddress(
  row: {
    street_address?: string | null
    city?: string | null
    state?: string | null
    country?: string | null
    settings?: unknown
  },
): string | null {
  const line = [row.street_address, row.city, row.state, row.country]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ")
  if (line) return line
  if (row.settings != null && typeof row.settings === "object") {
    return textOrNull((row.settings as Record<string, unknown>).address)
  }
  return null
}

function buildOptions(
  emisor: "responsable_inscripto" | "monotributo",
  validCuit: boolean,
): SaleComprobanteOption[] {
  const out: SaleComprobanteOption[] = [
    { kind: "none", label: "Sin comprobante" },
    { kind: "internal", label: "Recibo X" },
  ]
  if (!validCuit) return out
  for (const item of SALE_PICKER_ARCA) {
    if (item.emisor !== emisor) continue
    out.push({
      kind: "arca",
      label: item.label,
      arcaCbteTipo: item.arcaCbteTipo,
      arcaRegimen: "fe_general",
    })
  }
  return out
}

export async function loadSaleComprobantes(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: SaleComprobantesData }
  | { success: false; error: string }
> {
  const [popRes, salePointRes] = await Promise.all([
    supabase
      .from("pops")
      .select(
        "name, fiscal_cuit, fiscal_razon_social, street_address, city, state, country, phone, fiscal_ingresos_brutos_text, fiscal_inicio_actividades_date, settings",
      )
      .eq("id", popId)
      .maybeSingle(),
    supabase
      .from("arca_sale_points")
      .select("pto_vta")
      .eq("pop_id", popId)
      .order("pto_vta", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])

  if (popRes.error) return { success: false, error: popRes.error.message }
  if (!popRes.data) return { success: false, error: "Punto de venta no encontrado" }

  const data = popRes.data
  const validCuit = hasValidFiscalCuit(data.fiscal_cuit)
  const emisorIvaCondition = emisorIvaFromSettings(data.settings, validCuit)
  const tradeName = textOrNull(data.name) || "Comercio"
  let arcaPtoVta: number | null = null
  if (salePointRes.data?.pto_vta != null) {
    const parsed = Number(salePointRes.data.pto_vta)
    if (Number.isFinite(parsed)) arcaPtoVta = parsed
  }
  return {
    success: true,
    data: {
      invoiceTypeSiteId: DEFAULT_SALE_SITE_ID,
      hasValidFiscalCuit: validCuit,
      emisorIvaCondition,
      options: buildOptions(emisorIvaCondition, validCuit),
      emitter: {
        tradeName,
        razonSocial: textOrNull(data.fiscal_razon_social) || tradeName,
        address: popAddress(data),
        cuit: textOrNull(data.fiscal_cuit),
        ingresosBrutos: textOrNull(data.fiscal_ingresos_brutos_text),
        inicioActividades: data.fiscal_inicio_actividades_date
          ? String(data.fiscal_inicio_actividades_date).slice(0, 10)
          : null,
        phone: textOrNull(data.phone),
        arcaPtoVta,
        ivaCondition: emisorIvaCondition,
        ivaConditionLabel: emisorIvaLabel(emisorIvaCondition, validCuit),
        hasValidFiscalCuit: validCuit,
      },
    },
  }
}
