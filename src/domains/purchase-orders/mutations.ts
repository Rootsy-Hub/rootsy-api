import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { auditedDelete, auditedInsert } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
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
  audit: MutationAuditCtx,
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
    const id = randomUUID()
    const row = {
      id,
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
    }
    const applied = await auditedInsert(supabase, {
      kind: "purchase-orders.create",
      table: "purchase_orders",
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
      orderId: id,
      orderNumber,
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
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data, error } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("pop_id", popId)
    .eq("id", orderId)
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    return { success: false, error: "Orden de compra no encontrada.", status: 404 }
  }
  const applied = await auditedDelete(supabase, {
    kind: "purchase-orders.delete",
    table: "purchase_orders",
    id: orderId,
    ctx: audit,
    popId,
    previous: data,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
