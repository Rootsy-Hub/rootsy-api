import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { auditedDelete, auditedInsert } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { checkoutSnapshotHasItems } from "./parse.js"
import type { CreateQuoteBody } from "./schema.js"

type MutateResult =
  | { success: true; quoteId?: string; quoteNumber?: number }
  | { success: false; error: string; status: 400 | 404 | 500 }

async function nextQuoteNumber(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("sale_quotes")
    .select("quote_number")
    .eq("pop_id", popId)
    .order("quote_number", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return (Number(data?.quote_number) || 0) + 1
}

export async function createQuote(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: CreateQuoteBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  if (!checkoutSnapshotHasItems(input.checkoutSnapshot)) {
    return {
      success: false,
      error: "El presupuesto debe tener al menos un ítem.",
      status: 400,
    }
  }

  try {
    const quoteNumber = await nextQuoteNumber(supabase, popId)
    const id = randomUUID()
    const row = {
      id,
      pop_id: popId,
      quote_number: quoteNumber,
      client_id: input.clientId,
      customer_name: input.customerName.trim(),
      customer_tax_id: input.customerTaxId,
      subtotal: input.subtotal,
      discount_total: input.discountTotal,
      total: input.total,
      checkout_snapshot: input.checkoutSnapshot,
      metadata: input.metadata ?? {},
      created_by: userId,
    }
    const applied = await auditedInsert(supabase, {
      kind: "quotes.create",
      table: "sale_quotes",
      row,
      ctx: audit,
      popId,
    })
    if (!applied.success) {
      return {
        success: false,
        error: applied.error,
        status: applied.status,
      }
    }

    return {
      success: true,
      quoteId: id,
      quoteNumber,
    }
  } catch (e: unknown) {
    return {
      success: false,
      error:
        e instanceof Error ? e.message : "No se pudo guardar el presupuesto.",
      status: 500,
    }
  }
}

export async function deleteQuote(
  supabase: SupabaseClient,
  popId: string,
  quoteId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data, error } = await supabase
    .from("sale_quotes")
    .select("*")
    .eq("pop_id", popId)
    .eq("id", quoteId)
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    return { success: false, error: "Presupuesto no encontrado.", status: 404 }
  }
  const applied = await auditedDelete(supabase, {
    kind: "quotes.delete",
    table: "sale_quotes",
    id: quoteId,
    ctx: audit,
    popId,
    previous: data,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
