import type { SupabaseClient } from "@supabase/supabase-js"
import { findInvoiceTypeByArcaCbteTipo } from "./catalog.js"
import type { InvoiceArcaRow, InvoiceListData, ListInvoicesQuery } from "./schema.js"
import { INVOICE_RECIBO_X_FILTER } from "./schema.js"

const INVOICE_ARCA_SELECT = `
  id,
  sale_id,
  arca_cbte_tipo,
  arca_regimen,
  pto_vta,
  cbte_nro,
  cbte_fch,
  doc_tipo,
  doc_nro,
  receptor_razon_social,
  imp_total,
  imp_neto,
  imp_iva,
  imp_trib,
  mon_id,
  mon_cotiz,
  cae,
  cae_fch_vto,
  status,
  arca_resultado,
  arca_observaciones,
  payload_request,
  payload_response
`

const INVOICE_LIST_SORT: Record<string, string> = {
  cbte_fch: "cbte_fch",
  imp_total: "imp_total",
  receptor: "receptor_razon_social",
  status: "status",
}

function parseMoney(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function escapeIlikePattern(q: string): string {
  return q
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/,/g, " ")
}

function mapInvoiceArcaRow(
  row: Record<string, unknown>,
  siteId: string,
): InvoiceArcaRow {
  const cbteTipo = Number(row.arca_cbte_tipo ?? 0)
  const opt = findInvoiceTypeByArcaCbteTipo(siteId, cbteTipo)
  const nro = row.cbte_nro
  const cbteNroStr =
    typeof nro === "bigint" || typeof nro === "number"
      ? String(nro)
      : String(nro ?? "")

  return {
    id: String(row.id),
    saleId: row.sale_id != null ? String(row.sale_id) : null,
    arcaCbteTipo: cbteTipo,
    tipoLabel: opt?.label ?? `CbteTipo ${cbteTipo}`,
    arcaRegimen: String(row.arca_regimen ?? "fe_general"),
    ptoVta: Number(row.pto_vta ?? 0),
    cbteNro: cbteNroStr,
    cbteFch: String(row.cbte_fch ?? ""),
    docTipo: row.doc_tipo != null ? Number(row.doc_tipo) : null,
    docNro: String(row.doc_nro ?? ""),
    receptorRazonSocial: String(row.receptor_razon_social ?? ""),
    impTotal: parseMoney(row.imp_total),
    impNeto: parseMoney(row.imp_neto),
    impIva: parseMoney(row.imp_iva),
    impTrib: parseMoney(row.imp_trib),
    monId: String(row.mon_id ?? "PES"),
    monCotiz: Number(row.mon_cotiz ?? 1),
    cae: row.cae != null ? String(row.cae) : null,
    caeFchVto: row.cae_fch_vto != null ? String(row.cae_fch_vto) : null,
    status: String(row.status ?? ""),
    arcaResultado:
      row.arca_resultado != null ? String(row.arca_resultado) : null,
    arcaObservaciones:
      row.arca_observaciones != null ? String(row.arca_observaciones) : null,
    payloadRequest: row.payload_request ?? {},
    payloadResponse: row.payload_response ?? {},
  }
}

function appendInvoiceListFilters<
  Q extends {
    eq: (a: string, b: string | number) => Q
    gte: (a: string, b: string) => Q
    lte: (a: string, b: string) => Q
    or: (s: string) => Q
  },
>(q: Q, input: ListInvoicesQuery): Q {
  let x = q
  if (input.status) x = x.eq("status", input.status)
  if (input.cbteTipo === INVOICE_RECIBO_X_FILTER) {
    x = x.eq("arca_cbte_tipo", -1)
  } else if (input.cbteTipo !== "") {
    x = x.eq("arca_cbte_tipo", input.cbteTipo)
  }
  if (input.dateFrom) x = x.gte("cbte_fch", input.dateFrom)
  if (input.dateTo) x = x.lte("cbte_fch", input.dateTo)
  if (input.search) {
    const pattern = `%${escapeIlikePattern(input.search)}%`
    const orParts = [
      `receptor_razon_social.ilike.${pattern}`,
      `cae.ilike.${pattern}`,
      `doc_nro.ilike.${pattern}`,
    ]
    if (/^\d+$/.test(input.search)) {
      orParts.push(`cbte_nro.eq.${input.search}`, `pto_vta.eq.${input.search}`)
    }
    x = x.or(orParts.join(","))
  }
  return x
}

export async function listInvoices(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  input: ListInvoicesQuery,
  caps: Pick<InvoiceListData, "canCreate" | "canUpdate" | "canDelete">,
): Promise<
  { success: true; data: InvoiceListData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("invoices_arca")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  countQuery = appendInvoiceListFilters(countQuery, input)

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize) || 1)
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const hasUserSort = input.sort != null && input.sort in INVOICE_LIST_SORT
  const sortColumn = hasUserSort
    ? INVOICE_LIST_SORT[input.sort as string]
    : "cbte_fch"
  const ascending = hasUserSort ? input.ord === "asc" : false

  let dataQuery = supabase
    .from("invoices_arca")
    .select(INVOICE_ARCA_SELECT)
    .eq("pop_id", popId)
  dataQuery = appendInvoiceListFilters(dataQuery, input)
  dataQuery = dataQuery.order(sortColumn ?? "cbte_fch", { ascending })
  if (!hasUserSort) {
    dataQuery = dataQuery.order("created_at", { ascending: false })
  }
  dataQuery = dataQuery.range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      invoices: (data ?? []).map((row) =>
        mapInvoiceArcaRow(row as Record<string, unknown>, siteId),
      ),
      totalCount,
      page,
      pageSize: input.pageSize,
      ...caps,
    },
  }
}
