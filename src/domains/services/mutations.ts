import type { SupabaseClient } from "@supabase/supabase-js"
import {
  isServiceBillingPeriod,
  isServicePaymentTiming,
  normalizeServiceDetailsGrid,
  serviceDeleteConfirmPhrase,
} from "./catalog.js"
import type {
  ServiceAddonInput,
  ServiceArticleInput,
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

async function syncServiceTypeArticles(
  supabase: SupabaseClient,
  popId: string,
  serviceTypeId: string,
  articles: ServiceArticleInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error: deleteError } = await supabase
    .from("service_type_articles")
    .delete()
    .eq("service_type_id", serviceTypeId)
    .eq("pop_id", popId)
  if (deleteError) return { ok: false, error: deleteError.message }

  const rows = articles
    .filter((line) => line.articleId.trim() && line.quantity > 0)
    .map((line, index) => ({
      pop_id: popId,
      service_type_id: serviceTypeId,
      article_id: line.articleId.trim(),
      quantity: line.quantity,
      sort_order: index,
    }))
  if (rows.length === 0) return { ok: true }

  const { error: insertError } = await supabase
    .from("service_type_articles")
    .insert(rows)
  if (insertError) return { ok: false, error: insertError.message }
  return { ok: true }
}

async function syncServiceTypeAddons(
  supabase: SupabaseClient,
  popId: string,
  serviceTypeId: string,
  addons: ServiceAddonInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error: deleteError } = await supabase
    .from("service_type_addons")
    .delete()
    .eq("service_type_id", serviceTypeId)
    .eq("pop_id", popId)
  if (deleteError) return { ok: false, error: deleteError.message }

  const rows = addons
    .map((addon) => ({
      name: addon.name.trim(),
      price: addon.price,
      articles: addon.articles.filter(
        (line) => line.articleId.trim() && line.quantity > 0,
      ),
    }))
    .filter((addon) => addon.name.length > 0)

  for (let index = 0; index < rows.length; index += 1) {
    const addon = rows[index]
    const { data, error } = await supabase
      .from("service_type_addons")
      .insert({
        pop_id: popId,
        service_type_id: serviceTypeId,
        name: addon.name,
        price: addon.price,
        sort_order: index,
      })
      .select("id")
      .single()
    if (error || !data?.id) {
      return {
        ok: false,
        error: error?.message || "No se pudieron guardar los adicionales.",
      }
    }

    const articleRows = addon.articles.map((line, articleIndex) => ({
      pop_id: popId,
      addon_id: String(data.id),
      article_id: line.articleId.trim(),
      quantity: line.quantity,
      sort_order: articleIndex,
    }))
    if (articleRows.length === 0) continue

    const { error: insertArticlesError } = await supabase
      .from("service_type_addon_articles")
      .insert(articleRows)
    if (insertArticlesError) {
      return { ok: false, error: insertArticlesError.message }
    }
  }

  return { ok: true }
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

  const { data, error } = await supabase
    .from("service_types")
    .insert({
      pop_id: popId,
      ...serviceWritePayload(input),
    })
    .select("id")
    .single()

  if (error || !data?.id) {
    return {
      success: false,
      error: error?.message || "No se pudo crear el servicio.",
      status: 500,
    }
  }

  const serviceId = String(data.id)
  const articlesSync = await syncServiceTypeArticles(
    supabase,
    popId,
    serviceId,
    input.articles,
  )
  if (!articlesSync.ok) {
    return { success: false, error: articlesSync.error, status: 400 }
  }
  const addonsSync = await syncServiceTypeAddons(
    supabase,
    popId,
    serviceId,
    input.addons,
  )
  if (!addonsSync.ok) {
    return { success: false, error: addonsSync.error, status: 400 }
  }
  return { success: true, id: serviceId }
}

export async function updateService(
  supabase: SupabaseClient,
  popId: string,
  serviceId: string,
  input: UpsertServiceBody,
): Promise<MutateResult> {
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

  const { error } = await supabase
    .from("service_types")
    .update(serviceWritePayload(input))
    .eq("id", serviceId)
    .eq("pop_id", popId)
    .is("deleted_at", null)

  if (error) return { success: false, error: error.message, status: 500 }

  const articlesSync = await syncServiceTypeArticles(
    supabase,
    popId,
    serviceId,
    input.articles,
  )
  if (!articlesSync.ok) {
    return { success: false, error: articlesSync.error, status: 400 }
  }
  const addonsSync = await syncServiceTypeAddons(
    supabase,
    popId,
    serviceId,
    input.addons,
  )
  if (!addonsSync.ok) {
    return { success: false, error: addonsSync.error, status: 400 }
  }
  return { success: true }
}

export async function deleteService(
  supabase: SupabaseClient,
  popId: string,
  serviceId: string,
  confirmationTyped: string,
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

  const { error } = await supabase
    .from("service_types")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", serviceId)
    .eq("pop_id", popId)
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}
