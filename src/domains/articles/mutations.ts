import type { SupabaseClient } from "@supabase/supabase-js"
import { createInitialStockLedger } from "./initialStock.js"
import {
  articleDbPayloadFromInput,
  articleDeleteConfirmPhrase,
  isAllowedArticleIvaRate,
  isValidStoredUnitOfMeasure,
  normalizeCatalogFields,
  normalizeIdentifierFields,
  primarySaleUnitCostFromCosts,
  validateArticleCostLines,
} from "./normalize.js"
import type { CostLineInput, ListPriceAmountInput, UpsertArticleBody } from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 403 | 404 | 409 | 500 }

async function validateCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("categories")
    .select("id")
    .eq("id", categoryId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error || !data?.id) return { ok: false, error: "Categoría inválida." }
  return { ok: true }
}

function validateUpsertFields(
  input: UpsertArticleBody,
  popSiteId: string,
): { ok: true } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) return { ok: false, error: "El nombre no puede quedar vacío." }
  if (!isValidStoredUnitOfMeasure(input.unitOfMeasure)) {
    return { ok: false, error: "Unidad de medida inválida." }
  }
  const salePrice = Number(input.salePrice)
  const iva = Number(input.iva)
  if (!Number.isFinite(salePrice) || salePrice < 0) {
    return { ok: false, error: "Precio inválido." }
  }
  if (!Number.isFinite(iva) || iva < 0 || !isAllowedArticleIvaRate(iva)) {
    return { ok: false, error: "Elegí un tipo de IVA válido." }
  }
  if (input.itemKind === "merchandise" && salePrice <= 0) {
    return {
      ok: false,
      error: "Indicá un precio de venta mayor que cero para mercadería.",
    }
  }
  if (input.siteId && input.siteId.trim() && input.siteId.trim() !== popSiteId) {
    return { ok: false, error: "El sitio de la URL no coincide con el punto de venta." }
  }
  return { ok: true }
}

async function syncArticleCosts(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  lines: CostLineInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const validated = validateArticleCostLines(lines)
  if (!validated.ok) return validated

  const normalized = validated.lines
  const supplierIds = [
    ...new Set(
      normalized
        .map((line) => line.supplierId?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ]

  if (supplierIds.length > 0) {
    const { data: validRows, error: validErr } = await supabase
      .from("suppliers")
      .select("id")
      .eq("pop_id", popId)
      .in("id", supplierIds)
    if (validErr) {
      return {
        ok: false,
        error: validErr.message || "No se pudieron validar proveedores.",
      }
    }
    const validIds = new Set((validRows ?? []).map((row) => String(row.id)))
    for (const id of supplierIds) {
      if (!validIds.has(id)) {
        return { ok: false, error: "Un proveedor del costo no es válido." }
      }
    }
  }

  const { error: delErr } = await supabase
    .from("article_costs")
    .delete()
    .eq("article_id", articleId)
    .eq("pop_id", popId)
  if (delErr) {
    return { ok: false, error: delErr.message || "No se pudieron actualizar costos." }
  }

  if (normalized.length === 0) return { ok: true }

  const { error: insErr } = await supabase.from("article_costs").insert(
    normalized.map((line, index) => ({
      pop_id: popId,
      article_id: articleId,
      supplier_id: line.supplierId?.trim() || null,
      name: (line.name ?? "").trim(),
      cost_unit_label: line.costUnitLabel.trim(),
      sale_units_per_cost_unit: line.saleUnitsPerCostUnit,
      unit_price: line.unitPrice,
      is_active: line.isActive !== false,
      sort_order: index,
    })),
  )
  if (insErr) {
    return { ok: false, error: insErr.message || "No se pudieron guardar los costos." }
  }
  return { ok: true }
}

async function syncItemPriceListAmounts(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  inputs: ListPriceAmountInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: extraLists, error: listsError } = await supabase
    .from("price_lists")
    .select("id")
    .eq("pop_id", popId)
    .eq("is_default", false)
  if (listsError) return { ok: false, error: listsError.message }

  const extraIds = new Set((extraLists ?? []).map((row) => String(row.id)))
  const wanted = inputs.filter((row) => extraIds.has(row.listId))

  for (const row of wanted) {
    if (row.amount == null) {
      const { error } = await supabase
        .from("price_list_items")
        .delete()
        .eq("pop_id", popId)
        .eq("price_list_id", row.listId)
        .eq("item_kind", "article")
        .eq("item_id", articleId)
      if (error) return { ok: false, error: error.message }
      continue
    }

    const { error } = await supabase.from("price_list_items").upsert(
      {
        pop_id: popId,
        price_list_id: row.listId,
        item_kind: "article",
        item_id: articleId,
        amount: row.amount,
      },
      { onConflict: "price_list_id,item_kind,item_id" },
    )
    if (error) return { ok: false, error: error.message }
  }

  return { ok: true }
}

export async function createArticle(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  userId: string,
  input: UpsertArticleBody,
): Promise<MutateResult> {
  const fields = validateUpsertFields(input, popSiteId)
  if (!fields.ok) return { success: false, error: fields.error, status: 400 }

  const categoryId = input.categoryId.trim()
  const cat = await validateCategory(supabase, popId, categoryId)
  if (!cat.ok) return { success: false, error: cat.error, status: 400 }

  const costLines = input.costs ?? []
  const rawInitial = input.initialStockQuantity
  const initialQty = rawInitial == null ? 0 : Number(rawInitial)
  const wantsInitial =
    Number.isFinite(initialQty) && Number.isInteger(initialQty) && initialQty > 0
  let initialUnitCostSaleUom: number | null = null
  if (wantsInitial) {
    if (initialQty < 1 || initialQty > 10000) {
      return {
        success: false,
        error: "El stock inicial debe ser un entero entre 1 y 10000.",
        status: 400,
      }
    }
    initialUnitCostSaleUom = primarySaleUnitCostFromCosts(costLines)
    if (initialUnitCostSaleUom == null || initialUnitCostSaleUom <= 0) {
      return {
        success: false,
        error:
          "Para registrar stock inicial agregá al menos un costo activo con precio mayor que cero.",
        status: 400,
      }
    }
  }

  const catalogNorm = normalizeCatalogFields(input)
  if (!catalogNorm.ok) return { success: false, error: catalogNorm.error, status: 400 }
  const idFields = normalizeIdentifierFields(input)
  if (!idFields.ok) return { success: false, error: idFields.error, status: 400 }
  const { brand, discountMode, discountValue } = catalogNorm.fields

  const imageUrlInsert = input.imageUrl.trim()
  const salePrice = Number(input.salePrice)
  const iva = Number(input.iva)

  const { data: created, error } = await supabase
    .from("articles")
    .insert({
      pop_id: popId,
      name: input.name.trim(),
      description: input.description.trim(),
      image_url: imageUrlInsert ? imageUrlInsert : null,
      sale_price: input.itemKind === "merchandise" ? salePrice : 0,
      iva,
      category_id: categoryId,
      is_active: input.isActive,
      ...articleDbPayloadFromInput({
        ...input,
        brand,
        sku: idFields.sku ?? "",
        barcode: idFields.barcode ?? "",
        discountMode,
        discountValue,
      }),
    })
    .select("id")
    .single()

  if (error || !created?.id) {
    return {
      success: false,
      error: error?.message || "No se pudo crear.",
      status: 500,
    }
  }
  const articleId = String(created.id)

  const syncCosts = await syncArticleCosts(supabase, popId, articleId, costLines)
  if (!syncCosts.ok) {
    await supabase.from("articles").delete().eq("id", articleId).eq("pop_id", popId)
    return { success: false, error: syncCosts.error, status: 400 }
  }

  if (input.itemKind === "merchandise") {
    const syncLists = await syncItemPriceListAmounts(
      supabase,
      popId,
      articleId,
      input.listPrices ?? [],
    )
    if (!syncLists.ok) {
      await supabase.from("articles").delete().eq("id", articleId).eq("pop_id", popId)
      return { success: false, error: syncLists.error, status: 400 }
    }
  }

  if (wantsInitial && initialUnitCostSaleUom != null) {
    const stockRes = await createInitialStockLedger(supabase, {
      popId,
      popSiteId,
      userId,
      articleId,
      quantity: initialQty,
      unitCostSaleUom: initialUnitCostSaleUom,
    })
    if (!stockRes.success) {
      await supabase.from("articles").delete().eq("id", articleId).eq("pop_id", popId)
      return { success: false, error: stockRes.error, status: 400 }
    }
  }

  return { success: true }
}

export async function updateArticle(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  articleId: string,
  input: UpsertArticleBody,
): Promise<MutateResult> {
  const fields = validateUpsertFields(input, popSiteId)
  if (!fields.ok) return { success: false, error: fields.error, status: 400 }

  const categoryId = input.categoryId.trim()
  const cat = await validateCategory(supabase, popId, categoryId)
  if (!cat.ok) return { success: false, error: cat.error, status: 400 }

  const catalogNorm = normalizeCatalogFields(input)
  if (!catalogNorm.ok) return { success: false, error: catalogNorm.error, status: 400 }
  const idFields = normalizeIdentifierFields(input)
  if (!idFields.ok) return { success: false, error: idFields.error, status: 400 }
  const { brand, discountMode, discountValue } = catalogNorm.fields

  const imageUrl = input.imageUrl.trim()
  const salePrice = Number(input.salePrice)
  const iva = Number(input.iva)

  const { data, error } = await supabase
    .from("articles")
    .update({
      name: input.name.trim(),
      description: input.description.trim(),
      image_url: imageUrl ? imageUrl : null,
      sale_price: input.itemKind === "merchandise" ? salePrice : 0,
      iva,
      category_id: categoryId,
      is_active: input.isActive,
      ...articleDbPayloadFromInput({
        ...input,
        brand,
        sku: idFields.sku ?? "",
        barcode: idFields.barcode ?? "",
        discountMode,
        discountValue,
      }),
    })
    .eq("id", articleId)
    .eq("pop_id", popId)
    .select("id")
    .maybeSingle()

  if (error) {
    return { success: false, error: error.message || "No se pudo guardar.", status: 500 }
  }
  if (!data) return { success: false, error: "Artículo no encontrado.", status: 404 }

  if (input.costs != null) {
    const syncCosts = await syncArticleCosts(supabase, popId, articleId, input.costs)
    if (!syncCosts.ok) return { success: false, error: syncCosts.error, status: 400 }
  }

  if (input.itemKind === "merchandise") {
    const syncLists = await syncItemPriceListAmounts(
      supabase,
      popId,
      articleId,
      input.listPrices ?? [],
    )
    if (!syncLists.ok) return { success: false, error: syncLists.error, status: 400 }
  }

  return { success: true }
}

export async function deleteArticle(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  confirmationTyped: string,
): Promise<MutateResult> {
  const { data: article, error: fetchError } = await supabase
    .from("articles")
    .select("name")
    .eq("id", articleId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return {
      success: false,
      error: fetchError.message || "No se encontró el artículo.",
      status: 500,
    }
  }
  if (!article) {
    return { success: false, error: "No se encontró el artículo.", status: 404 }
  }
  const expectedPhrase = articleDeleteConfirmPhrase(String(article.name ?? ""))
  if (confirmationTyped.trim() !== expectedPhrase) {
    return {
      success: false,
      error: `Escribí (${expectedPhrase}) para confirmar el borrado.`,
      status: 400,
    }
  }
  const { error } = await supabase
    .from("articles")
    .delete()
    .eq("id", articleId)
    .eq("pop_id", popId)
  if (error) {
    return { success: false, error: error.message || "No se pudo eliminar.", status: 500 }
  }
  return { success: true }
}
