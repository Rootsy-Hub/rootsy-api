import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { auditedInsert, auditedUpdate } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { generateArcaCsrAndKey } from "./generateCsr.js"
import {
  ARCA_SALE_POINT_SELECT,
  mapSalePoint,
  type SalePointDbRow,
} from "./queries.js"
import type { ArcaSalePointRow } from "./schema.js"

const DUPLICATE_PTO_VTA = "Ya existe un punto de venta con ese número."

type GeneratedPair = {
  csrPem: string
  keyPem: string
}

function isDuplicatePtoVta(message: string): boolean {
  return /duplicate key|unique|pto_vta/i.test(message)
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
  audit: MutationAuditCtx,
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

  const id = randomUUID()
  const row: SalePointDbRow = {
    id,
    pto_vta: ptoVta,
    certificate_expires_at: null,
    certificate_crt_uploaded_at: null,
    certificate_key_uploaded_at: null,
    certificate_csr_uploaded_at: null,
  }
  const applied = await auditedInsert(supabase, {
    kind: "arca-sale-points.create",
    table: "arca_sale_points",
    row: { id, pop_id: popId, pto_vta: ptoVta },
    ctx: audit,
    popId,
    next: row,
  })
  if (!applied.success) {
    if (isDuplicatePtoVta(applied.error)) {
      return { success: false, error: DUPLICATE_PTO_VTA, status: 400 }
    }
    return {
      success: false,
      error: applied.error || "No se pudo crear el punto de venta.",
      status: 500,
    }
  }
  return {
    success: true,
    data: mapSalePoint(row),
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
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: ArcaSalePointRow }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const { data: current, error: fetchError } = await supabase
    .from("arca_sale_points")
    .select(ARCA_SALE_POINT_SELECT)
    .eq("id", salePointId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return { success: false, error: fetchError.message, status: 500 }
  }
  if (!current) {
    return { success: false, error: "Punto de venta no encontrado", status: 404 }
  }

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

  const next = { ...current, ...patch }
  const applied = await auditedUpdate(supabase, {
    kind: "arca-sale-points.patch",
    table: "arca_sale_points",
    id: salePointId,
    row: patch,
    ctx: audit,
    popId,
    previous: current,
    next,
  })
  if (!applied.success) {
    if (isDuplicatePtoVta(applied.error)) {
      return { success: false, error: DUPLICATE_PTO_VTA, status: 400 }
    }
    return {
      success: false,
      error: applied.error,
      status: applied.status === 404 ? 404 : 500,
    }
  }
  return { success: true, data: mapSalePoint(next as SalePointDbRow) }
}
