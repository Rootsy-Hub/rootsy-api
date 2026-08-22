import type { SupabaseClient } from "@supabase/supabase-js"
import { generateArcaCsrAndKey } from "./generateCsr.js"
import {
  ARCA_SALE_POINT_SELECT,
  isUniquePtoVtaError,
  mapSalePoint,
  type SalePointDbRow,
} from "./queries.js"
import type { ArcaSalePointRow } from "./schema.js"

const DUPLICATE_PTO_VTA = "Ya existe un punto de venta con ese número."

type GeneratedPair = {
  csrPem: string
  keyPem: string
}

async function loadPopFiscal(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; cuit: string; razonSocial: string | null }
  | { success: false; error: string; status: 400 | 500 }
> {
  const { data, error } = await supabase
    .from("pops")
    .select("fiscal_cuit, fiscal_razon_social")
    .eq("id", popId)
    .maybeSingle()
  if (error) {
    return { success: false, error: error.message, status: 500 }
  }
  const cuit = String(data?.fiscal_cuit ?? "").replace(/\D/g, "")
  if (cuit.length !== 11) {
    return {
      success: false,
      error: "Configurá el CUIT fiscal del negocio antes de generar el CSR.",
      status: 400,
    }
  }
  return {
    success: true,
    cuit,
    razonSocial: data?.fiscal_razon_social
      ? String(data.fiscal_razon_social)
      : null,
  }
}

export async function createArcaSalePoint(
  supabase: SupabaseClient,
  popId: string,
  ptoVta: number,
): Promise<
  | { success: true; data: ArcaSalePointRow; csrPem: string; keyPem: string }
  | { success: false; error: string; status: 400 | 500 }
> {
  const fiscal = await loadPopFiscal(supabase, popId)
  if (!fiscal.success) return fiscal

  const generated = generateArcaCsrAndKey({
    cuit: fiscal.cuit,
    razonSocial: fiscal.razonSocial,
  })
  if (!generated.success) {
    return { success: false, error: generated.error, status: 400 }
  }

  const { data, error } = await supabase
    .from("arca_sale_points")
    .insert({ pop_id: popId, pto_vta: ptoVta })
    .select(ARCA_SALE_POINT_SELECT)
    .single()

  if (error || !data) {
    if (isUniquePtoVtaError(error)) {
      return { success: false, error: DUPLICATE_PTO_VTA, status: 400 }
    }
    return {
      success: false,
      error: error?.message || "No se pudo crear el punto de venta.",
      status: 500,
    }
  }
  return {
    success: true,
    data: mapSalePoint(data as SalePointDbRow),
    csrPem: generated.csrPem,
    keyPem: generated.keyPem,
  }
}

export async function generateArcaSalePointCsr(
  supabase: SupabaseClient,
  popId: string,
  salePointId: string,
): Promise<
  | { success: true; data: ArcaSalePointRow } & GeneratedPair
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const existing = await supabase
    .from("arca_sale_points")
    .select(ARCA_SALE_POINT_SELECT)
    .eq("id", salePointId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (existing.error) {
    return { success: false, error: existing.error.message, status: 500 }
  }
  if (!existing.data) {
    return { success: false, error: "Punto de venta no encontrado", status: 404 }
  }
  const row = mapSalePoint(existing.data as SalePointDbRow)
  if (row.keyUploadedAt) {
    return {
      success: false,
      error: "Este punto de venta ya tiene una clave privada.",
      status: 400,
    }
  }

  const fiscal = await loadPopFiscal(supabase, popId)
  if (!fiscal.success) return fiscal
  const generated = generateArcaCsrAndKey({
    cuit: fiscal.cuit,
    razonSocial: fiscal.razonSocial,
  })
  if (!generated.success) {
    return { success: false, error: generated.error, status: 400 }
  }
  return {
    success: true,
    data: row,
    csrPem: generated.csrPem,
    keyPem: generated.keyPem,
  }
}

export async function updateArcaSalePoint(
  supabase: SupabaseClient,
  popId: string,
  salePointId: string,
  input: {
    ptoVta?: number
    expiresAt?: string | null
    certificatesUploaded?: boolean
    certificateUploaded?: boolean
    keyAndCsrUploaded?: boolean
  },
): Promise<
  | { success: true; data: ArcaSalePointRow }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const patch: Record<string, unknown> = {}
  if (input.ptoVta != null) patch.pto_vta = input.ptoVta
  if (input.expiresAt !== undefined) {
    patch.certificate_expires_at = input.expiresAt
  }
  if (input.certificatesUploaded) {
    const now = new Date().toISOString()
    patch.certificate_crt_uploaded_at = now
    patch.certificate_key_uploaded_at = now
  }
  if (input.certificateUploaded) {
    patch.certificate_crt_uploaded_at = new Date().toISOString()
  }
  if (input.keyAndCsrUploaded) {
    const now = new Date().toISOString()
    patch.certificate_key_uploaded_at = now
    patch.certificate_csr_uploaded_at = now
  }

  const { data, error } = await supabase
    .from("arca_sale_points")
    .update(patch)
    .eq("id", salePointId)
    .eq("pop_id", popId)
    .select(ARCA_SALE_POINT_SELECT)
    .maybeSingle()

  if (error) {
    if (isUniquePtoVtaError(error)) {
      return { success: false, error: DUPLICATE_PTO_VTA, status: 400 }
    }
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    return { success: false, error: "Punto de venta no encontrado", status: 404 }
  }
  return { success: true, data: mapSalePoint(data as SalePointDbRow) }
}
