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
  const { data, error } = await supabase
    .from("pops")
    .select("fiscal_cuit, settings")
    .eq("id", popId)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: "Punto de venta no encontrado" }

  const validCuit = hasValidFiscalCuit(data.fiscal_cuit)
  const emisorIvaCondition = emisorIvaFromSettings(data.settings, validCuit)
  return {
    success: true,
    data: {
      invoiceTypeSiteId: DEFAULT_SALE_SITE_ID,
      hasValidFiscalCuit: validCuit,
      emisorIvaCondition,
      options: buildOptions(emisorIvaCondition, validCuit),
    },
  }
}
