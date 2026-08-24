import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import { auditedUpdate } from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import {
  isServiceBillingPeriod,
  isServicePaymentTiming,
  normalizeServiceDetailsGrid,
  serviceDeleteConfirmPhrase,
} from "./catalog.js"
import { mergePatch } from "../../lib/patchBody.js"
import { getService } from "./queries.js"
import type {
  PatchServiceBody,
  ServiceAddonInput,
  ServiceArticleInput,
  ServiceDetail,
  UpsertServiceBody,
} from "./schema.js"

type MutateResult =
  | { success: true; id?: string }
  | { success: false; error: string; status: 400 | 403 | 404 | 409 | 500 }

function validateServiceInput(
  input: UpsertServiceBody,
): { ok: true } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) return { ok: false, error: "Indicá el nombre del servicio." }
  if (name.length > 200) {
    return { ok: false, error: "El nombre no puede superar 200 caracteres." }
  }
  const categoryId = input.categoryId.trim()
  if (!categoryId) return { ok: false, error: "Elegí una categoría." }
  const defaultPrice = Number(input.defaultPrice)
  if (!Number.isFinite(defaultPrice) || defaultPrice < 0) {
    return { ok: false, error: "Precio inválido." }
  }
  if (!isServiceBillingPeriod(input.billingPeriod)) {
    return { ok: false, error: "Período de cobro inválido." }
  }
  if (input.billingPeriod === "custom" && !input.billingPeriodLabel.trim()) {
    return {
      ok: false,
      error: "Indicá la etiqueta del período personalizado.",
    }
  }
  if (
    !Number.isFinite(input.dueDaysAfter) ||
    input.dueDaysAfter < 0 ||
    input.dueDaysAfter > 365
  ) {
    return {
      ok: false,
      error: "Los días de vencimiento deben estar entre 0 y 365.",
    }
  }
  if (!isServicePaymentTiming(input.paymentTiming)) {
    return { ok: false, error: "Momento de pago inválido." }
  }
  if (
    input.lateInterestType === "simple_percent" &&
    (input.lateInterestValue == null ||
      !Number.isFinite(input.lateInterestValue) ||
      input.lateInterestValue <= 0)
  ) {
    return { ok: false, error: "Indicá un interés por mora válido." }
  }
  if (
    input.discountMode === "porcentaje" &&
    input.discountValue != null &&
    (input.discountValue <= 0 || input.discountValue > 100)
  ) {
    return { ok: false, error: "El descuento porcentual debe ser entre 1 y 100." }
  }
  if (
    input.discountMode === "fijo" &&
    input.discountValue != null &&
    input.discountValue <= 0
  ) {
    return { ok: false, error: "Indicá un descuento fijo válido." }
  }
  for (const line of input.articles) {
    if (!line.articleId.trim()) {
      return { ok: false, error: "Artículo inválido en la composición." }
    }
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      return { ok: false, error: "Cantidad inválida en artículos del servicio." }
    }
  }
  for (const addon of input.addons) {
    if (!addon.name.trim()) {
      return { ok: false, error: "Indicá el nombre de cada adicional." }
    }
    if (!Number.isFinite(addon.price) || addon.price < 0) {
      return { ok: false, error: "Precio inválido en un adicional." }
    }
    for (const line of addon.articles) {
      if (!line.articleId.trim()) {
        return { ok: false, error: "Artículo inválido en un adicional." }
      }
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        return {
          ok: false,
          error: "Cantidad inválida en artículos de un adicional.",
        }
      }
    }
  }
  return { ok: true }
}

async function assertCategoryBelongsToPop(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("service_categories")
    .select("id")
    .eq("id", categoryId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data?.id) {
    return { ok: false, error: "La categoría no existe en este punto de venta." }
  }
  return { ok: true }
}

function serviceArticleReplaceOps(
  popId: string,
  serviceTypeId: string,
  articles: ServiceArticleInput[],
  existingIds: string[],
): AuditOp[] {
  const ops: AuditOp[] = existingIds.map((id) => ({
    op: "delete",
    table: "service_type_articles",
    id,
  }))
  const rows = articles.filter((line) => line.articleId.trim() && line.quantity > 0)
  for (const [index, line] of rows.entries()) {
    ops.push({
      op: "insert",
      table: "service_type_articles",
      row: {
        id: randomUUID(),
        pop_id: popId,
        service_type_id: serviceTypeId,
        article_id: line.articleId.trim(),
        quantity: line.quantity,
        sort_order: index,
      },
    })
  }
  return ops
}

function serviceAddonReplaceOps(
  popId: string,
  serviceTypeId: string,
  addons: ServiceAddonInput[],
  existing: { addonId: string; articleIds: string[] }[],
): AuditOp[] {
  const ops: AuditOp[] = []
  for (const addon of existing) {
    for (const articleId of addon.articleIds) {
      ops.push({ op: "delete", table: "service_type_addon_articles", id: articleId })
    }
    ops.push({ op: "delete", table: "service_type_addons", id: addon.addonId })
  }

  const rows = addons
    .map((addon) => ({
      name: addon.name.trim(),
      price: addon.price,
      articles: addon.articles.filter(
        (line) => line.articleId.trim() && line.quantity > 0,
      ),
    }))
    .filter((addon) => addon.name.length > 0)

  for (const [index, addon] of rows.entries()) {
    const addonId = randomUUID()
    ops.push({
      op: "insert",
      table: "service_type_addons",
      row: {
        id: addonId,
        pop_id: popId,
        service_type_id: serviceTypeId,
        name: addon.name,
        price: addon.price,
        sort_order: index,
      },
    })
    for (const [articleIndex, line] of addon.articles.entries()) {
      ops.push({
        op: "insert",
        table: "service_type_addon_articles",
        row: {
          id: randomUUID(),
          pop_id: popId,
          addon_id: addonId,
          article_id: line.articleId.trim(),
          quantity: line.quantity,
          sort_order: articleIndex,
        },
      })
    }
  }
  return ops
}

function serviceWritePayload(input: UpsertServiceBody) {
  const detailsGrid = normalizeServiceDetailsGrid(input.detailsGrid)
  return {
    category_id: input.categoryId.trim(),
    name: input.name.trim(),
    description: input.description.trim(),
    image_url: input.imageUrl.trim() || null,
    default_price: input.defaultPrice,
    billing_period: input.billingPeriod,
    billing_period_label:
      input.billingPeriod === "custom" ? input.billingPeriodLabel.trim() : null,
    details_grid: detailsGrid,
    contract_text: input.contractText.trim(),
    payment_timing: input.paymentTiming,
    due_days_after: input.dueDaysAfter,
    late_interest_type: input.lateInterestType,
    late_interest_value:
      input.lateInterestType === "simple_percent"
        ? input.lateInterestValue
        : null,
    discount_mode: input.discountMode,
    discount_value: input.discountMode === "none" ? null : input.discountValue,
    is_active: input.isActive,
  }
}

export async function createService(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertServiceBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const validation = validateServiceInput(input)
  if (!validation.ok) {
    return { success: false, error: validation.error, status: 400 }
  }

  const categoryCheck = await assertCategoryBelongsToPop(
    supabase,
    popId,
    input.categoryId.trim(),
  )
  if (!categoryCheck.ok) {
    return { success: false, error: categoryCheck.error, status: 400 }
  }

  const serviceId = randomUUID()
  const serviceRow = {
    id: serviceId,
    pop_id: popId,
    ...serviceWritePayload(input),
  }
  const ops: AuditOp[] = [{ op: "insert", table: "service_types", row: serviceRow }]
  ops.push(...serviceArticleReplaceOps(popId, serviceId, input.articles, []))
  ops.push(...serviceAddonReplaceOps(popId, serviceId, input.addons, []))

  const applied = await applyWithAudit(supabase, {
    kind: "services.create",
    ctx: audit,
    popId,
    resourceId: serviceId,
    previous: null,
    next: serviceRow,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, id: serviceId }
}

function serviceToUpsertBody(row: ServiceDetail): UpsertServiceBody {
  return {
    name: row.name,
    description: row.description,
    categoryId: row.categoryId ?? "",
    imageUrl: row.imageUrl ?? "",
    defaultPrice: row.defaultPrice,
    billingPeriod: row.billingPeriod,
    billingPeriodLabel: row.billingPeriodLabel ?? "",
    detailsGrid: row.detailsGrid,
    contractText: row.contractText,
    paymentTiming: row.paymentTiming,
    dueDaysAfter: row.dueDaysAfter,
    lateInterestType: row.lateInterestType,
    lateInterestValue: row.lateInterestValue,
    discountMode: row.discountMode,
    discountValue: row.discountValue,
    articles: row.articles.map((line) => ({
      articleId: line.articleId,
      quantity: line.quantity,
    })),
    addons: row.addons.map((addon) => ({
      name: addon.name,
      price: addon.price,
      articles: addon.articles.map((line) => ({
        articleId: line.articleId,
        quantity: line.quantity,
      })),
    })),
    isActive: row.isActive,
  }
}

export async function updateService(
  supabase: SupabaseClient,
  popId: string,
  serviceId: string,
  patch: PatchServiceBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getService(supabase, popId, serviceId)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(serviceToUpsertBody(current.data), patch)

  const validation = validateServiceInput(input)
  if (!validation.ok) {
    return { success: false, error: validation.error, status: 400 }
  }

  const { data: existing } = await supabase
    .from("service_types")
    .select("id")
    .eq("id", serviceId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
  if (!existing?.id) {
    return { success: false, error: "No se encontró el servicio.", status: 404 }
  }

  const categoryCheck = await assertCategoryBelongsToPop(
    supabase,
    popId,
    input.categoryId.trim(),
  )
  if (!categoryCheck.ok) {
    return { success: false, error: categoryCheck.error, status: 400 }
  }

  const updateRow = serviceWritePayload(input)
  const ops: AuditOp[] = [
    { op: "update", table: "service_types", id: serviceId, row: updateRow },
  ]

  if (patch.articles !== undefined) {
    ops.push(
      ...serviceArticleReplaceOps(
        popId,
        serviceId,
        patch.articles,
        current.data.articles.map((line) => line.id),
      ),
    )
  }
  if (patch.addons !== undefined) {
    ops.push(
      ...serviceAddonReplaceOps(
        popId,
        serviceId,
        patch.addons,
        current.data.addons.map((addon) => ({
          addonId: addon.id,
          articleIds: addon.articles.map((line) => line.id),
        })),
      ),
    )
  }

  const applied = await applyWithAudit(supabase, {
    kind: "services.patch",
    ctx: audit,
    popId,
    resourceId: serviceId,
    previous: current.data,
    next: { ...current.data, ...input },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function deleteService(
  supabase: SupabaseClient,
  popId: string,
  serviceId: string,
  confirmationTyped: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: service, error: fetchError } = await supabase
    .from("service_types")
    .select("name")
    .eq("id", serviceId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
  if (fetchError) {
    return {
      success: false,
      error: fetchError.message || "No se encontró el servicio.",
      status: 500,
    }
  }
  if (!service) {
    return { success: false, error: "No se encontró el servicio.", status: 404 }
  }

  const expectedPhrase = serviceDeleteConfirmPhrase(String(service.name ?? ""))
  if (confirmationTyped.trim() !== expectedPhrase) {
    return {
      success: false,
      error: `Escribí (${expectedPhrase}) para confirmar el borrado.`,
      status: 400,
    }
  }

  const applied = await auditedUpdate(supabase, {
    kind: "services.delete",
    table: "service_types",
    id: serviceId,
    row: { deleted_at: new Date().toISOString(), is_active: false },
    ctx: audit,
    popId,
    previous: service,
    next: { ...service, deleted_at: true, is_active: false },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
