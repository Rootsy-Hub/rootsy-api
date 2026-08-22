import type { SupabaseClient } from "@supabase/supabase-js"
import type { ArcaFiscalConfig, ArcaSalePointRow } from "./schema.js"

const SELECT =
  "id, pto_vta, certificate_expires_at, certificate_crt_uploaded_at, certificate_key_uploaded_at, certificate_csr_uploaded_at"

type SalePointDbRow = {
  id: string
  pto_vta: number
  certificate_expires_at: string | null
  certificate_crt_uploaded_at: string | null
  certificate_key_uploaded_at: string | null
  certificate_csr_uploaded_at: string | null
}

function argentinaTodayYmd(): string {
  return new Date()
    .toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" })
    .slice(0, 10)
}

function daysUntil(ymd: string | null): number | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return null
  const exp = Date.parse(`${ymd.slice(0, 10)}T00:00:00`)
  const today = Date.parse(`${argentinaTodayYmd()}T00:00:00`)
  if (!Number.isFinite(exp) || !Number.isFinite(today)) return null
  return Math.round((exp - today) / 86_400_000)
}

export function mapSalePoint(row: SalePointDbRow): ArcaSalePointRow {
  const crtUploadedAt = row.certificate_crt_uploaded_at
  const keyUploadedAt = row.certificate_key_uploaded_at
  const csrUploadedAt = row.certificate_csr_uploaded_at
  const configured = Boolean(crtUploadedAt && keyUploadedAt)
  const expiresAt = row.certificate_expires_at
    ? String(row.certificate_expires_at).slice(0, 10)
    : null
  return {
    id: row.id,
    ptoVta: Number(row.pto_vta),
    expiresAt,
    crtUploadedAt,
    keyUploadedAt,
    csrUploadedAt,
    configured,
    daysUntilExpiry: daysUntil(expiresAt),
  }
}

export function isUniquePtoVtaError(error: { code?: string } | null): boolean {
  return error?.code === "23505"
}

export async function listArcaSalePoints(
  supabase: SupabaseClient,
  popId: string,
  caps: { canCreate: boolean; canUpdate: boolean },
): Promise<
  | { success: true; data: ArcaFiscalConfig }
  | { success: false; error: string }
> {
  const [popRes, pointsRes] = await Promise.all([
    supabase
      .from("pops")
      .select("fiscal_cuit, fiscal_razon_social")
      .eq("id", popId)
      .maybeSingle(),
    supabase
      .from("arca_sale_points")
      .select(SELECT)
      .eq("pop_id", popId)
      .order("pto_vta", { ascending: true }),
  ])

  if (popRes.error) return { success: false, error: popRes.error.message }
  if (pointsRes.error) return { success: false, error: pointsRes.error.message }

  const fiscalCuit = popRes.data?.fiscal_cuit
    ? String(popRes.data.fiscal_cuit).replace(/\D/g, "")
    : ""

  return {
    success: true,
    data: {
      fiscalCuit: fiscalCuit.length === 11 ? fiscalCuit : null,
      fiscalRazonSocial: popRes.data?.fiscal_razon_social
        ? String(popRes.data.fiscal_razon_social)
        : null,
      salePoints: (pointsRes.data ?? []).map((row) =>
        mapSalePoint(row as SalePointDbRow),
      ),
      canCreate: caps.canCreate,
      canUpdate: caps.canUpdate,
    },
  }
}

export async function getArcaSalePoint(
  supabase: SupabaseClient,
  popId: string,
  salePointId: string,
): Promise<
  | { success: true; data: ArcaSalePointRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("arca_sale_points")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("id", salePointId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Punto de venta no encontrado", status: 404 }
  }
  return { success: true, data: mapSalePoint(data as SalePointDbRow) }
}

export { SELECT as ARCA_SALE_POINT_SELECT }
export type { SalePointDbRow }
