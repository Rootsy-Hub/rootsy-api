import type { SupabaseClient } from "@supabase/supabase-js"
import {
  scheduleDateFromDb,
  scheduleDaysFromDb,
  scheduleTimeFromDb,
} from "./schedule.js"
import { effectiveArticlePrice } from "../sale/articleMap.js"
import type {
  ListPromotionsQuery,
  PromotionCatalogOption,
  PromotionDetail,
  PromotionListData,
  PromotionListRow,
  PromotionRow,
  PromotionSlotOptionRow,
  PromotionSlotRow,
} from "./schema.js"
import {
  isPromotionBenefitTarget,
  isPromotionPricingMode,
  isPromotionType,
  promotionPricingSummary,
  type PromotionBenefitTarget,
} from "./types.js"

export const PROMOTION_SELECT = `
  id,
  pop_id,
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
  sort_order,
  valid_from,
  valid_until,
  valid_time_start,
  valid_time_end,
  schedule_days
`

const PROMOTION_LIST_SORT: Record<string, string> = {
  name: "name",
  promotion_type: "promotion_type",
  valid_from: "valid_from",
  valid_until: "valid_until",
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

export function mapPromotionRow(
  row: Record<string, unknown>,
  slotCount = 0,
  optionCount = 0,
): PromotionRow {
  const rawImg = row.image_url
  const imageUrl =
    typeof rawImg === "string" && rawImg.trim() !== "" ? rawImg.trim() : null
  const promotionType = String(row.promotion_type ?? "combo")
  const pricingMode = String(row.pricing_mode ?? "fixed_total")
  const typeSafe = isPromotionType(promotionType) ? promotionType : "combo"
  const pricingSafe = isPromotionPricingMode(pricingMode)
    ? pricingMode
    : "fixed_total"
  const discountModeRaw = row.discount_mode
  const discountMode =
    discountModeRaw === "porcentaje" || discountModeRaw === "fijo"
      ? discountModeRaw
      : null
  const applyRaw = row.apply_benefit_to
  const applyBenefitTo = isPromotionBenefitTarget(String(applyRaw ?? ""))
    ? (String(applyRaw) as PromotionBenefitTarget)
    : null

  const scheduleDays = scheduleDaysFromDb(row.schedule_days)
  const validFrom = scheduleDateFromDb(row.valid_from)
  const validUntil = scheduleDateFromDb(row.valid_until)
  const validTimeStart = scheduleTimeFromDb(row.valid_time_start)
  const validTimeEnd = scheduleTimeFromDb(row.valid_time_end)

  const pricingSummary = promotionPricingSummary({
    promotionType: typeSafe,
    pricingMode: pricingSafe,
    fixedPrice: row.fixed_price != null ? Number(row.fixed_price) || 0 : null,
    discountMode,
    discountValue:
      row.discount_value != null ? Number(row.discount_value) || 0 : null,
    buyQuantity: row.buy_quantity != null ? Number(row.buy_quantity) : null,
    benefitQuantity:
      row.benefit_quantity != null ? Number(row.benefit_quantity) : null,
    benefitDiscountPct:
      row.benefit_discount_pct != null
        ? Number(row.benefit_discount_pct)
        : null,
    applyBenefitTo,
  })

  const scheduleParts: string[] = []
  if (validFrom || validUntil) {
    scheduleParts.push(`${validFrom ?? "…"} → ${validUntil ?? "…"}`)
  }
  if (validTimeStart && validTimeEnd) {
    scheduleParts.push(`${validTimeStart}–${validTimeEnd}`)
  }
  if (scheduleDays.length > 0 && scheduleDays.length < 7) {
    const labels = ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"]
    scheduleParts.push(scheduleDays.map((d) => labels[d]).join(", "))
  }

  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    imageUrl,
    promotionType: typeSafe,
    pricingMode: pricingSafe,
    fixedPrice: row.fixed_price != null ? Number(row.fixed_price) || 0 : null,
    discountMode,
    discountValue:
      row.discount_value != null ? Number(row.discount_value) || 0 : null,
    buyQuantity: row.buy_quantity != null ? Number(row.buy_quantity) : null,
    benefitQuantity:
      row.benefit_quantity != null ? Number(row.benefit_quantity) : null,
    benefitDiscountPct:
      row.benefit_discount_pct != null
        ? Number(row.benefit_discount_pct)
        : null,
    applyBenefitTo,
    autoApply: Boolean(row.auto_apply),
    showInMenu: Boolean(row.show_in_menu),
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order ?? 0) || 0,
    validFrom,
    validUntil,
    validTimeStart,
    validTimeEnd,
    scheduleDays,
    slotCount,
    optionCount,
    pricingSummary,
    scheduleSummary:
      scheduleParts.length > 0 ? scheduleParts.join(" · ") : "Siempre activa",
  }
}

export async function loadPromotionSlotsByIds(
  supabase: SupabaseClient,
  popId: string,
  promotionIds: string[],
): Promise<Map<string, PromotionSlotRow[]>> {
  const slotsByPromo = new Map<string, PromotionSlotRow[]>()
  if (promotionIds.length === 0) return slotsByPromo

  const { data: slotRows } = await supabase
    .from("promotion_slots")
    .select("id, promotion_id, label, quantity, sort_order")
    .eq("pop_id", popId)
    .in("promotion_id", promotionIds)
    .order("sort_order", { ascending: true })

  if (!slotRows?.length) return slotsByPromo

  const slotIds = slotRows.map((r) => String(r.id))
  const { data: optRows } = await supabase
    .from("promotion_slot_options")
    .select("id, promotion_slot_id, article_id, recipe_id, sort_order")
    .eq("pop_id", popId)
    .in("promotion_slot_id", slotIds)
    .order("sort_order", { ascending: true })

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

  const optsBySlot = new Map<string, PromotionSlotOptionRow[]>()
  for (const row of optRows ?? []) {
    const slotId = String(row.promotion_slot_id)
    const list = optsBySlot.get(slotId) ?? []
    if (row.article_id) {
      const id = String(row.article_id)
      const meta = articleMeta.get(id)
      list.push({
        id: String(row.id),
        kind: "article",
        refId: id,
        name: meta?.name ?? "—",
        salePrice: meta?.salePrice ?? 0,
        iva: meta?.iva ?? 0,
      })
    } else if (row.recipe_id) {
      const id = String(row.recipe_id)
      const meta = recipeMeta.get(id)
      list.push({
        id: String(row.id),
        kind: "recipe",
        refId: id,
        name: meta?.name ?? "—",
        salePrice: meta?.salePrice ?? 0,
        iva: meta?.iva ?? 0,
      })
    }
    optsBySlot.set(slotId, list)
  }

  for (const slot of slotRows) {
    const promoId = String(slot.promotion_id)
    const list = slotsByPromo.get(promoId) ?? []
    list.push({
      id: String(slot.id),
      label: String(slot.label ?? ""),
      quantity: Number(slot.quantity ?? 1) || 1,
      sortOrder: Number(slot.sort_order ?? 0) || 0,
      options: optsBySlot.get(String(slot.id)) ?? [],
    })
    slotsByPromo.set(promoId, list)
  }
  return slotsByPromo
}

export async function loadPromotionSlots(
  supabase: SupabaseClient,
  popId: string,
  promotionId: string,
): Promise<PromotionSlotRow[]> {
  const slotsByPromo = await loadPromotionSlotsByIds(supabase, popId, [
    promotionId,
  ])
  return slotsByPromo.get(promotionId) ?? []
}

export async function listPromotions(
  supabase: SupabaseClient,
  popId: string,
  input: ListPromotionsQuery,
  caps: Pick<PromotionListData, "canCreate" | "canUpdate" | "canDelete">,
): Promise<
  { success: true; data: PromotionListData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("promotions")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  if (input.soloActivos) countQuery = countQuery.eq("is_active", true)
  if (input.promotionType) {
    countQuery = countQuery.eq("promotion_type", input.promotionType)
  }
  if (input.search) {
    const pattern = `%${escapeIlikeToken(input.search)}%`
    countQuery = countQuery.or(
      `name.ilike.${pattern},description.ilike.${pattern}`,
    )
  }

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const sortColumn = input.sort ? PROMOTION_LIST_SORT[input.sort] : undefined

  let dataQuery = supabase
    .from("promotions")
    .select(PROMOTION_SELECT)
    .eq("pop_id", popId)
  if (input.soloActivos) dataQuery = dataQuery.eq("is_active", true)
  if (input.promotionType) {
    dataQuery = dataQuery.eq("promotion_type", input.promotionType)
  }
  if (input.search) {
    const pattern = `%${escapeIlikeToken(input.search)}%`
    dataQuery = dataQuery.or(
      `name.ilike.${pattern},description.ilike.${pattern}`,
    )
  }
  if (sortColumn) {
    dataQuery = dataQuery.order(sortColumn, { ascending: input.ord === "asc" })
  } else {
    dataQuery = dataQuery
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
  }
  dataQuery = dataQuery.range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  const promoIds = (data ?? []).map((r) => String(r.id))
  const slotCounts = new Map<string, number>()
  const optionCounts = new Map<string, number>()
  const slotsByPromo = input.includeSlots
    ? await loadPromotionSlotsByIds(supabase, popId, promoIds)
    : null

  if (slotsByPromo) {
    for (const [pid, slots] of slotsByPromo) {
      slotCounts.set(pid, slots.length)
      optionCounts.set(
        pid,
        slots.reduce((n, slot) => n + slot.options.length, 0),
      )
    }
  } else if (promoIds.length > 0) {
    const { data: slots } = await supabase
      .from("promotion_slots")
      .select("id, promotion_id")
      .eq("pop_id", popId)
      .in("promotion_id", promoIds)
    const slotIds = (slots ?? []).map((s) => String(s.id))
    for (const s of slots ?? []) {
      const pid = String(s.promotion_id)
      slotCounts.set(pid, (slotCounts.get(pid) ?? 0) + 1)
    }
    if (slotIds.length > 0) {
      const { data: opts } = await supabase
        .from("promotion_slot_options")
        .select("promotion_slot_id")
        .eq("pop_id", popId)
        .in("promotion_slot_id", slotIds)
      const slotToPromo = new Map(
        (slots ?? []).map((s) => [String(s.id), String(s.promotion_id)]),
      )
      for (const o of opts ?? []) {
        const pid = slotToPromo.get(String(o.promotion_slot_id))
        if (pid) optionCounts.set(pid, (optionCounts.get(pid) ?? 0) + 1)
      }
    }
  }

  const promotions: PromotionListRow[] = (data ?? []).map((row) => {
    const id = String(row.id)
    const mapped = mapPromotionRow(
      row as Record<string, unknown>,
      slotCounts.get(id) ?? 0,
      optionCounts.get(id) ?? 0,
    )
    if (!input.includeSlots) return mapped
    return { ...mapped, slots: slotsByPromo?.get(id) ?? [] }
  })

  return {
    success: true,
    data: {
      promotions,
      totalCount,
      page,
      pageSize: input.pageSize,
      ...caps,
    },
  }
}

export async function getPromotion(
  supabase: SupabaseClient,
  popId: string,
  promotionId: string,
): Promise<
  | { success: true; data: PromotionDetail }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("promotions")
    .select(PROMOTION_SELECT)
    .eq("id", promotionId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Promoción no encontrada.", status: 404 }
  }

  const slots = await loadPromotionSlots(supabase, popId, promotionId)
  const optionCount = slots.reduce((n, s) => n + s.options.length, 0)
  return {
    success: true,
    data: {
      ...mapPromotionRow(data as Record<string, unknown>, slots.length, optionCount),
      slots,
    },
  }
}

export async function listPromotionCatalog(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: PromotionCatalogOption[] }
  | { success: false; error: string }
> {
  const [articlesRes, recipesRes] = await Promise.all([
    supabase
      .from("articles")
      .select("id, name, sale_price")
      .eq("pop_id", popId)
      .eq("is_active", true)
      .eq("item_kind", "merchandise")
      .order("name", { ascending: true }),
    supabase
      .from("recipes")
      .select("id, name, sale_price")
      .eq("pop_id", popId)
      .eq("is_active", true)
      .order("name", { ascending: true }),
  ])

  if (articlesRes.error) return { success: false, error: articlesRes.error.message }
  if (recipesRes.error) return { success: false, error: recipesRes.error.message }

  const options: PromotionCatalogOption[] = [
    ...(articlesRes.data ?? []).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      kind: "article" as const,
      salePrice: Number(r.sale_price ?? 0) || 0,
    })),
    ...(recipesRes.data ?? []).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      kind: "recipe" as const,
      salePrice: Number(r.sale_price ?? 0) || 0,
    })),
  ]
  options.sort((a, b) => a.name.localeCompare(b.name, "es"))
  return { success: true, data: options }
}
