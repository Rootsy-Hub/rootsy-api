import type { SupabaseClient } from "@supabase/supabase-js"
import { checkoutSnapshotHasItems } from "./parse.js"
import type { CreatePurchaseOrderBody } from "./schema.js"

type MutateResult =
  | { success: true; orderId?: string; orderNumber?: number }
  | { success: false; error: string; status: 400 | 404 | 500 }

async function nextOrderNumber(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("purchase_orders")
    .select("order_number")
    .eq("pop_id", popId)
    .order("order_number", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return (Number(data?.order_number) || 0) + 1
}

export async function createPurchaseOrder(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: CreatePurchaseOrderBody,
): Promise<MutateResult> {
  if (!checkoutSnapshotHasItems(input.checkoutSnapshot)) {
    return {
      success: false,
      error: "La orden de compra debe tener al menos un ítem.",
      status: 400,
    }
  }

  try {
    const orderNumber = await nextOrderNumber(supabase, popId)
    const { data, error } = await supabase
      .from("purchase_orders")
      .insert({
        pop_id: popId,
        order_number: orderNumber,
        supplier_id: input.supplierId,
        supplier_name: input.supplierName.trim(),
        supplier_tax_id: input.supplierTaxId,
        subtotal: input.subtotal,
        discount_total: input.discountTotal,
        total: input.total,
        checkout_snapshot: input.checkoutSnapshot,
        metadata: input.metadata ?? {},
        created_by: userId,
      })
      .select("id, order_number")
      .single()

    if (error || !data) {
      return {
        success: false,
        error: error?.message || "No se pudo guardar la orden de compra.",
        status: 500,
      }
    }

    return {
      success: true,
      orderId: String(data.id),
      orderNumber: Number(data.order_number) || orderNumber,
    }
  } catch (e: unknown) {
    return {
      success: false,
      error:
        e instanceof Error
          ? e.message
          : "No se pudo guardar la orden de compra.",
      status: 500,
    }
  }
}

export async function deletePurchaseOrder(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
): Promise<MutateResult> {
  const { data, error } = await supabase
    .from("purchase_orders")
    .delete()
    .eq("pop_id", popId)
    .eq("id", orderId)
    .select("id")
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    return { success: false, error: "Orden de compra no encontrada.", status: 404 }
  }
  return { success: true }
}
