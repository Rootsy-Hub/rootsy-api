import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import { auditedDelete } from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import { normalizeScheduleDays, validatePromotionSchedule } from "./schedule.js"
import { mergePatch } from "../../lib/patchBody.js"
import { getPromotion } from "./queries.js"
import type {
  PatchPromotionBody,
  PromotionDetail,
  SlotInput,
  UpsertPromotionBody,
} from "./schema.js"
import {
  isPromotionBenefitTarget,
  isPromotionOptionKind,
  isPromotionPricingMode,
  isPromotionType,
} from "./types.js"

type MutateResult =
  | { success: true; id?: string }
  | { success: false; error: string; status: 400 | 404 | 500 }

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  )
}

function promotionDeleteConfirmPhrase(promotionName: string): string {
  const name = promotionName.trim() || "esta promoción"
  return `Eliminar ${name}`
}

function validatePromotionInput(
  input: UpsertPromotionBody,
): { ok: true } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) return { ok: false, error: "Indicá el nombre de la promoción." }
  if (name.length > 200) {
    return { ok: false, error: "El nombre no puede superar 200 caracteres." }
  }
  if (!isPromotionType(input.promotionType)) {
    return { ok: false, error: "Tipo de promoción inválido." }
  }

  const scheduleCheck = validatePromotionSchedule({
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    validTimeStart: input.validTimeStart,
    validTimeEnd: input.validTimeEnd,
    scheduleDays: input.scheduleDays,
  })
  if (!scheduleCheck.ok) return scheduleCheck

  if (input.promotionType === "combo") {
    if (!isPromotionPricingMode(input.pricingMode)) {
      return { ok: false, error: "Modo de precio inválido." }
    }
    if (input.pricingMode === "fixed_total") {
      const fixed = Number(input.fixedPrice)
      if (!Number.isFinite(fixed) || fixed < 0) {
        return { ok: false, error: "Precio fijo inválido." }
      }
    } else if (input.pricingMode === "percent_off") {
      const pct = Number(input.discountValue)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return { ok: false, error: "Porcentaje de descuento inválido." }
      }
    } else if (input.pricingMode === "fixed_off") {
      const amt = Number(input.discountValue)
      if (!Number.isFinite(amt) || amt < 0) {
        return { ok: false, error: "Monto de descuento inválido." }
      }
    }
    if (!input.slots.length) {
      return { ok: false, error: "Agregá al menos un ítem al combo." }
    }
    for (const slot of input.slots) {
      const label = slot.label.trim()
      if (!label) {
        return { ok: false, error: "Cada ítem del combo necesita un nombre." }
      }
      const qty = Number(slot.quantity)
      if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
        return { ok: false, error: "Cantidad de ítem inválida." }
      }
      if (!slot.options.length) {
        return {
          ok: false,
          error: `Agregá productos o recetas al ítem «${label}».`,
        }
      }
      const seen = new Set<string>()
      for (const opt of slot.options) {
        if (!isPromotionOptionKind(opt.kind) || !isUuid(opt.refId.trim())) {
          return { ok: false, error: "Opción de ítem inválida." }
        }
        const key = `${opt.kind}:${opt.refId.trim()}`
        if (seen.has(key)) {
          return {
            ok: false,
            error: `No podés repetir la misma opción en «${label}».`,
          }
        }
        seen.add(key)
      }
    }
    return { ok: true }
  }

  const buy = Number(input.buyQuantity)
  const benefit = Number(input.benefitQuantity)
  const pct = Number(input.benefitDiscountPct)
  if (!Number.isFinite(buy) || buy < 1 || !Number.isInteger(buy)) {
    return { ok: false, error: "Cantidad a comprar inválida." }
  }
  if (!Number.isFinite(benefit) || benefit < 1 || !Number.isInteger(benefit)) {
    return { ok: false, error: "Cantidad bonificada inválida." }
  }
  if (benefit > buy) {
    return {
      ok: false,
      error: "La cantidad bonificada no puede superar la cantidad a comprar.",
    }
  }
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: "Porcentaje de beneficio inválido." }
  }
  if (!input.applyBenefitTo || !isPromotionBenefitTarget(input.applyBenefitTo)) {
    return { ok: false, error: "Indicá a qué unidad aplica el beneficio." }
  }
  const pool = input.slots[0]
  if (!pool?.options.length) {
    return {
      ok: false,
      error: "Agregá al menos un producto o receta elegible.",
    }
  }
  const seenPool = new Set<string>()
  for (const opt of pool.options) {
    if (!isPromotionOptionKind(opt.kind) || !isUuid(opt.refId.trim())) {
      return { ok: false, error: "Opción elegible inválida." }
    }
    const key = `${opt.kind}:${opt.refId.trim()}`
    if (seenPool.has(key)) {
      return { ok: false, error: "No podés repetir la misma opción elegible." }
    }
    seenPool.add(key)
  }
  return { ok: true }
}

async function validatePromotionOptions(
  supabase: SupabaseClient,
  popId: string,
  slots: SlotInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const articleIds = new Set<string>()
  const recipeIds = new Set<string>()
  for (const slot of slots) {
    for (const opt of slot.options) {
      const id = opt.refId.trim()
      if (opt.kind === "article") articleIds.add(id)
      else recipeIds.add(id)
    }
  }

  if (articleIds.size > 0) {
    const { data, error } = await supabase
      .from("articles")
      .select("id, is_active, item_kind")
      .eq("pop_id", popId)
      .in("id", [...articleIds])
    if (error) {
      return { ok: false, error: error.message || "No se pudieron validar productos." }
    }
    const byId = new Map((data ?? []).map((r) => [String(r.id), r]))
    for (const id of articleIds) {
      const row = byId.get(id)
      if (!row?.is_active) {
        return { ok: false, error: "Un producto elegible ya no está disponible." }
      }
      if (String(row.item_kind ?? "") !== "merchandise") {
        return {
          ok: false,
          error: "Solo podés incluir productos vendibles en promociones.",
        }
      }
    }
  }

  if (recipeIds.size > 0) {
    const { data, error } = await supabase
      .from("recipes")
      .select("id, is_active")
      .eq("pop_id", popId)
      .in("id", [...recipeIds])
    if (error) {
      return { ok: false, error: error.message || "No se pudieron validar recetas." }
    }
    const byId = new Map((data ?? []).map((r) => [String(r.id), r]))
    for (const id of recipeIds) {
      const row = byId.get(id)
      if (!row?.is_active) {
        return { ok: false, error: "Una receta elegible ya no está disponible." }
      }
    }
  }

  return { ok: true }
}

function promotionInsertRow(
  popId: string,
  input: UpsertPromotionBody,
  sortOrder: number,
): Record<string, unknown> {
  const imageUrl = input.imageUrl.trim()
  const scheduleDays = normalizeScheduleDays(input.scheduleDays)
  const base: Record<string, unknown> = {
    pop_id: popId,
    name: input.name.trim(),
    description: input.description.trim(),
    image_url: imageUrl ? imageUrl : null,
    promotion_type: input.promotionType,
    auto_apply: input.autoApply,
    show_in_menu: input.showInMenu,
    is_active: input.isActive,
    sort_order: sortOrder,
    valid_from: input.validFrom?.trim() || null,
    valid_until: input.validUntil?.trim() || null,
    valid_time_start: input.validTimeStart?.trim() || null,
    valid_time_end: input.validTimeEnd?.trim() || null,
    schedule_days: scheduleDays,
  }

  if (input.promotionType === "combo") {
    base.pricing_mode = input.pricingMode
    base.fixed_price =
      input.pricingMode === "fixed_total"
        ? roundMoney(Number(input.fixedPrice))
        : null
    base.discount_mode =
      input.pricingMode === "fixed_total" ? null : input.discountMode
    base.discount_value =
      input.pricingMode === "fixed_total"
        ? null
        : roundMoney(Number(input.discountValue))
    base.buy_quantity = null
    base.benefit_quantity = null
    base.benefit_discount_pct = null
    base.apply_benefit_to = null
  } else {
    base.pricing_mode = "percent_off"
    base.fixed_price = null
    base.discount_mode = "porcentaje"
    base.discount_value = null
    base.buy_quantity = Number(input.buyQuantity)
    base.benefit_quantity = Number(input.benefitQuantity)
    base.benefit_discount_pct = Number(input.benefitDiscountPct)
    base.apply_benefit_to = input.applyBenefitTo
  }

  return base
}

function buildSlotInsertOps(
  popId: string,
  promotionId: string,
  slots: SlotInput[],
): AuditOp[] {
  const ops: AuditOp[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const slotId = randomUUID()
    ops.push({
      op: "insert",
      table: "promotion_slots",
      row: {
        id: slotId,
        promotion_id: promotionId,
        pop_id: popId,
        label: slot.label.trim(),
        quantity: Number(slot.quantity),
        sort_order: i,
      },
    })
    for (const [index, opt] of slot.options.entries()) {
      ops.push({
        op: "insert",
        table: "promotion_slot_options",
        row: {
          id: randomUUID(),
          promotion_slot_id: slotId,
          pop_id: popId,
          article_id: opt.kind === "article" ? opt.refId.trim() : null,
          recipe_id: opt.kind === "recipe" ? opt.refId.trim() : null,
          sort_order: index,
        },
      })
    }
  }
  return ops
}

function slotReplaceOps(
  popId: string,
  promotionId: string,
  existingSlots: PromotionDetail["slots"],
  nextSlots: SlotInput[],
): AuditOp[] {
  const ops: AuditOp[] = []
  for (const slot of existingSlots) {
    for (const opt of slot.options) {
      ops.push({ op: "delete", table: "promotion_slot_options", id: opt.id })
    }
    ops.push({ op: "delete", table: "promotion_slots", id: slot.id })
  }
  ops.push(...buildSlotInsertOps(popId, promotionId, nextSlots))
  return ops
}

export async function createPromotion(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertPromotionBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const validation = validatePromotionInput(input)
  if (!validation.ok) return { success: false, error: validation.error, status: 400 }

  const optionsCheck = await validatePromotionOptions(supabase, popId, input.slots)
  if (!optionsCheck.ok) {
    return { success: false, error: optionsCheck.error, status: 400 }
  }

  const { data: maxRow } = await supabase
    .from("promotions")
    .select("sort_order")
    .eq("pop_id", popId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()
  const sortOrder = (Number(maxRow?.sort_order ?? -1) || -1) + 1

  const promotionId = randomUUID()
  const row = { id: promotionId, ...promotionInsertRow(popId, input, sortOrder) }
  const ops: AuditOp[] = [
    { op: "insert", table: "promotions", row },
    ...buildSlotInsertOps(popId, promotionId, input.slots),
  ]
  const applied = await applyWithAudit(supabase, {
    kind: "promotions.create",
    ctx: audit,
    popId,
    resourceId: promotionId,
    previous: null,
    next: { ...row, slots: input.slots },
    ops,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error || "No se pudo crear la promoción.",
      status: applied.status,
    }
  }

  return { success: true, id: promotionId }
}

function promotionToUpsertBody(row: PromotionDetail): UpsertPromotionBody {
  return {
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl ?? "",
    promotionType: row.promotionType,
    pricingMode: row.pricingMode,
    fixedPrice: row.fixedPrice,
    discountMode: row.discountMode,
    discountValue: row.discountValue,
    buyQuantity: row.buyQuantity,
    benefitQuantity: row.benefitQuantity,
    benefitDiscountPct: row.benefitDiscountPct,
    applyBenefitTo: row.applyBenefitTo,
    autoApply: row.autoApply,
    showInMenu: row.showInMenu,
    isActive: row.isActive,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    validTimeStart: row.validTimeStart,
    validTimeEnd: row.validTimeEnd,
    scheduleDays: row.scheduleDays,
    slots: row.slots.map((slot) => ({
      label: slot.label,
      quantity: slot.quantity,
      options: slot.options.map((option) => ({
        kind: option.kind,
        refId: option.refId,
      })),
    })),
  }
}

export async function updatePromotion(
  supabase: SupabaseClient,
  popId: string,
  promotionId: string,
  patch: PatchPromotionBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getPromotion(supabase, popId, promotionId)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(promotionToUpsertBody(current.data), patch)

  const validation = validatePromotionInput(input)
  if (!validation.ok) return { success: false, error: validation.error, status: 400 }

  const optionsCheck = await validatePromotionOptions(supabase, popId, input.slots)
  if (!optionsCheck.ok) {
    return { success: false, error: optionsCheck.error, status: 400 }
  }

  const sortOrder = Number(current.data.sortOrder ?? 0) || 0
  const updatePayload = promotionInsertRow(popId, input, sortOrder)
  const { pop_id: _popId, ...updateRow } = updatePayload
  const ops: AuditOp[] = [
    { op: "update", table: "promotions", id: promotionId, row: updateRow },
  ]
  if (patch.slots !== undefined) {
    ops.push(
      ...slotReplaceOps(popId, promotionId, current.data.slots, patch.slots),
    )
  }

  const applied = await applyWithAudit(supabase, {
    kind: "promotions.patch",
    ctx: audit,
    popId,
    resourceId: promotionId,
    previous: current.data,
    next: { ...current.data, ...updateRow, slots: input.slots },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  return { success: true }
}

export async function deletePromotion(
  supabase: SupabaseClient,
  popId: string,
  promotionId: string,
  confirmationTyped: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: promotion, error: fetchError } = await supabase
    .from("promotions")
    .select("name")
    .eq("id", promotionId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return {
      success: false,
      error: fetchError.message || "No se encontró la promoción.",
      status: 500,
    }
  }
  if (!promotion) {
    return { success: false, error: "No se encontró la promoción.", status: 404 }
  }

  const expectedPhrase = promotionDeleteConfirmPhrase(String(promotion.name ?? ""))
  if (confirmationTyped.trim() !== expectedPhrase) {
    return {
      success: false,
      error: `Escribí (${expectedPhrase}) para confirmar el borrado.`,
      status: 400,
    }
  }

  const applied = await auditedDelete(supabase, {
    kind: "promotions.delete",
    table: "promotions",
    id: promotionId,
    ctx: audit,
    popId,
    previous: promotion,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
