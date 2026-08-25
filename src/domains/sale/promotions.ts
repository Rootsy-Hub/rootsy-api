import type { SupabaseClient } from "@supabase/supabase-js"
import { effectiveArticlePrice } from "./articleMap.js"
import type { SalePromotion, SalePromotionOption, SalePromotionSlot } from "./schema.js"

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

function scheduleDateFromDb(raw: unknown): string | null {
  if (raw == null) return null
  const t = String(raw).trim()
  if (!t) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t)
  return m ? m[1] : null
}

function scheduleTimeFromDb(raw: unknown): string | null {
  if (raw == null) return null
  const t = String(raw).trim()
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return null
  return `${m[1].padStart(2, "0")}:${m[2]}`
}

function scheduleDaysFromDb(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...ALL_WEEKDAYS]
  const set = new Set<number>()
  for (const d of raw.map((v) => Number(v))) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d)
  }
  return set.size === 0 ? [...ALL_WEEKDAYS] : [...set].sort((a, b) => a - b)
}

function parseDateOnly(v: string | null): Date | null {
  if (!v) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

function parseTimeToMinutes(v: string | null): number | null {
  if (!v) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(v)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

function isScheduleActiveNow(row: {
  validFrom: string | null
  validUntil: string | null
  validTimeStart: string | null
  validTimeEnd: string | null
  scheduleDays: number[]
}): boolean {
  const at = new Date()
  const from = parseDateOnly(row.validFrom)
  const until = parseDateOnly(row.validUntil)
  if (from) {
    const start = new Date(from)
    start.setHours(0, 0, 0, 0)
    if (at < start) return false
  }
  if (until) {
    const end = new Date(until)
    end.setHours(23, 59, 59, 999)
    if (at > end) return false
  }
  if (!row.scheduleDays.includes(at.getDay())) return false
  const startMin = parseTimeToMinutes(row.validTimeStart)
  const endMin = parseTimeToMinutes(row.validTimeEnd)
  if (startMin != null && endMin != null) {
    const nowMin = at.getHours() * 60 + at.getMinutes()
    if (nowMin < startMin || nowMin >= endMin) return false
  }
  return true
}

function pricingLabel(input: {
  promotionType: "combo" | "quantity_deal"
  pricingMode: "fixed_total" | "percent_off" | "fixed_off"
  fixedPrice: number | null
  discountValue: number | null
  buyQuantity: number | null
  benefitQuantity: number | null
  benefitDiscountPct: number | null
  applyBenefitTo: "cheapest" | "most_expensive" | null
}): string {
  if (input.promotionType === "quantity_deal") {
    const buy = input.buyQuantity ?? 0
    const benefit = input.benefitQuantity ?? 0
    const pct = input.benefitDiscountPct ?? 0
    const target =
      input.applyBenefitTo === "most_expensive" ? "más caro" : "más barato"
    if (pct >= 100) return `${buy}x${buy - benefit} (${target})`
    return `${buy}+${benefit} al ${pct}% (${target})`
  }
  if (input.pricingMode === "fixed_total") {
    return `Precio fijo $${(input.fixedPrice ?? 0).toLocaleString("es-AR")}`
  }
  if (input.pricingMode === "percent_off") {
    return `${input.discountValue ?? 0}% off por ítem`
  }
  return `$${(input.discountValue ?? 0).toLocaleString("es-AR")} off por ítem`
}

function filterPromotionForSale(promotion: SalePromotion): SalePromotion | null {
  const slots = promotion.slots
    .map((slot) => ({
      ...slot,
      options: slot.options.filter((o) => o.kind === "article"),
    }))
    .filter((slot) => slot.options.length > 0)
  if (slots.length !== promotion.slots.length) return null
  return { ...promotion, slots }
}

export async function loadSalePromotions(
  supabase: SupabaseClient,
  popId: string,
): Promise<SalePromotion[]> {
  const { data: promoRows, error } = await supabase
    .from("promotions")
    .select(
      `
      id,
      name,
      description,
      image_url,
      promotion_type,
      pricing_mode,
      fixed_price,
      discount_mode,
      discount_value,
      buy_quantity,
      benefit_quantity,
      benefit_discount_pct,
      apply_benefit_to,
      auto_apply,
      show_in_menu,
      is_active,
      valid_from,
      valid_until,
      valid_time_start,
      valid_time_end,
      schedule_days
    `,
    )
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })

  if (error || !promoRows?.length) return []

  const activePromos = promoRows.filter((row) =>
    isScheduleActiveNow({
      validFrom: scheduleDateFromDb(row.valid_from),
      validUntil: scheduleDateFromDb(row.valid_until),
      validTimeStart: scheduleTimeFromDb(row.valid_time_start),
      validTimeEnd: scheduleTimeFromDb(row.valid_time_end),
      scheduleDays: scheduleDaysFromDb(row.schedule_days),
    }),
  )
  if (activePromos.length === 0) return []

  const promoIds = activePromos.map((r) => String(r.id))
  const { data: slotRows } = await supabase
    .from("promotion_slots")
    .select("id, promotion_id, label, quantity, sort_order")
    .eq("pop_id", popId)
    .in("promotion_id", promoIds)
    .order("sort_order", { ascending: true })

  const slotIds = (slotRows ?? []).map((s) => String(s.id))
  const { data: optRows } =
    slotIds.length > 0
      ? await supabase
          .from("promotion_slot_options")
          .select("id, promotion_slot_id, article_id, recipe_id, sort_order")
          .eq("pop_id", popId)
          .in("promotion_slot_id", slotIds)
          .order("sort_order", { ascending: true })
      : { data: [] as Record<string, unknown>[] }

  const articleIds = (optRows ?? [])
    .filter((r) => r.article_id)
    .map((r) => String(r.article_id))
  const recipeIds = (optRows ?? [])
    .filter((r) => r.recipe_id)
    .map((r) => String(r.recipe_id))

  const articleMeta = new Map<
    string,
    { name: string; salePrice: number; iva: number }
  >()
  if (articleIds.length > 0) {
    const { data } = await supabase
      .from("articles")
      .select("id, name, sale_price, iva, discount_mode, discount_value")
      .eq("pop_id", popId)
      .in("id", articleIds)
    for (const r of data ?? []) {
      articleMeta.set(String(r.id), {
        name: String(r.name ?? ""),
        salePrice: effectiveArticlePrice(
          Number(r.sale_price ?? 0) || 0,
          r.discount_mode,
          r.discount_value,
        ),
        iva: Number(r.iva ?? 0) || 0,
      })
    }
  }

  const recipeMeta = new Map<
    string,
    { name: string; salePrice: number; iva: number }
  >()
  if (recipeIds.length > 0) {
    const { data } = await supabase
      .from("recipes")
      .select("id, name, sale_price, iva")
      .eq("pop_id", popId)
      .in("id", recipeIds)
    for (const r of data ?? []) {
      recipeMeta.set(String(r.id), {
        name: String(r.name ?? ""),
        salePrice: Number(r.sale_price ?? 0) || 0,
        iva: Number(r.iva ?? 0) || 0,
      })
    }
  }

  const optsBySlot = new Map<string, SalePromotionOption[]>()
  for (const row of optRows ?? []) {
    const slotId = String(row.promotion_slot_id)
    const list = optsBySlot.get(slotId) ?? []
    if (row.article_id) {
      const id = String(row.article_id)
      const meta = articleMeta.get(id)
      if (meta) {
        list.push({
          kind: "article",
          refId: id,
          name: meta.name,
          salePrice: meta.salePrice,
          iva: meta.iva,
        })
      }
    } else if (row.recipe_id) {
      const id = String(row.recipe_id)
      const meta = recipeMeta.get(id)
      if (meta) {
        list.push({
          kind: "recipe",
          refId: id,
          name: meta.name,
          salePrice: meta.salePrice,
          iva: meta.iva,
        })
      }
    }
    optsBySlot.set(slotId, list)
  }

  const slotsByPromo = new Map<string, SalePromotionSlot[]>()
  for (const slot of slotRows ?? []) {
    const promoId = String(slot.promotion_id)
    const list = slotsByPromo.get(promoId) ?? []
    list.push({
      id: String(slot.id),
      label: String(slot.label ?? ""),
      quantity: Number(slot.quantity ?? 1) || 1,
      options: optsBySlot.get(String(slot.id)) ?? [],
    })
    slotsByPromo.set(promoId, list)
  }

  const result: SalePromotion[] = []
  for (const row of activePromos) {
    const promotionType =
      String(row.promotion_type) === "quantity_deal" ? "quantity_deal" : "combo"
    const showInMenu = Boolean(row.show_in_menu)
    const autoApply = Boolean(row.auto_apply)
    if (promotionType === "combo" && !showInMenu) continue
    if (promotionType === "quantity_deal" && !autoApply && !showInMenu) continue

    const slots = slotsByPromo.get(String(row.id)) ?? []
    if (slots.every((s) => s.options.length === 0)) continue

    const applyRaw = row.apply_benefit_to
    const applyBenefitTo =
      applyRaw === "cheapest" || applyRaw === "most_expensive"
        ? applyRaw
        : null
    const pricingMode =
      String(row.pricing_mode) === "percent_off"
        ? "percent_off"
        : String(row.pricing_mode) === "fixed_off"
          ? "fixed_off"
          : "fixed_total"

    result.push({
      id: String(row.id),
      name: String(row.name ?? ""),
      description: String(row.description ?? ""),
      imageUrl:
        typeof row.image_url === "string" && row.image_url.trim()
          ? row.image_url.trim()
          : null,
      promotionType,
      pricingMode,
      fixedPrice:
        row.fixed_price != null ? Number(row.fixed_price) || 0 : null,
      discountMode:
        row.discount_mode === "porcentaje" || row.discount_mode === "fijo"
          ? row.discount_mode
          : null,
      discountValue:
        row.discount_value != null ? Number(row.discount_value) : null,
      buyQuantity:
        row.buy_quantity != null ? Number(row.buy_quantity) : null,
      benefitQuantity:
        row.benefit_quantity != null ? Number(row.benefit_quantity) : null,
      benefitDiscountPct:
        row.benefit_discount_pct != null
          ? Number(row.benefit_discount_pct)
          : null,
      applyBenefitTo,
      autoApply,
      showInMenu,
      slots,
      pricingLabel: pricingLabel({
        promotionType,
        pricingMode,
        fixedPrice:
          row.fixed_price != null ? Number(row.fixed_price) || 0 : null,
        discountValue:
          row.discount_value != null ? Number(row.discount_value) : null,
        buyQuantity:
          row.buy_quantity != null ? Number(row.buy_quantity) : null,
        benefitQuantity:
          row.benefit_quantity != null ? Number(row.benefit_quantity) : null,
        benefitDiscountPct:
          row.benefit_discount_pct != null
            ? Number(row.benefit_discount_pct)
            : null,
        applyBenefitTo,
      }),
    })
  }

  return result
}

export function splitSalePromotions(all: SalePromotion[]): {
  promotions: SalePromotion[]
  quantityDeals: SalePromotion[]
} {
  const promotions = all
    .filter((p) => p.promotionType === "combo" && p.showInMenu)
    .map(filterPromotionForSale)
    .filter((p): p is SalePromotion => p != null)
  const quantityDeals = all.filter(
    (p) => p.promotionType === "quantity_deal" && p.autoApply,
  )
  return { promotions, quantityDeals }
}

/** Mesas / Mostrador: combos con recetas incluidas. */
export function splitMenuPromotions(all: SalePromotion[]): {
  promotions: SalePromotion[]
  quantityDeals: SalePromotion[]
} {
  return {
    promotions: all.filter((p) => p.promotionType === "combo" && p.showInMenu),
    quantityDeals: all.filter(
      (p) => p.promotionType === "quantity_deal" && p.autoApply,
    ),
  }
}
