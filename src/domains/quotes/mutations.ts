import type { SupabaseClient } from "@supabase/supabase-js"
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
    const { data, error } = await supabase
      .from("sale_quotes")
      .insert({
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
      })
      .select("id, quote_number")
      .single()

    if (error || !data) {
      return {
        success: false,
        error: error?.message || "No se pudo guardar el presupuesto.",
        status: 500,
      }
    }

    return {
      success: true,
      quoteId: String(data.id),
      quoteNumber: Number(data.quote_number) || quoteNumber,
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
): Promise<MutateResult> {
  const { data, error } = await supabase
    .from("sale_quotes")
    .delete()
    .eq("pop_id", popId)
    .eq("id", quoteId)
    .select("id")
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    return { success: false, error: "Presupuesto no encontrado.", status: 404 }
  }
  return { success: true }
}
