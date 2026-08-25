import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import { buildInitialStockLedgerOps } from "./initialStock.js"
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
import { mergePatch } from "../../lib/patchBody.js"
import { getArticle } from "./queries.js"
import type {
  ArticleRow,
  CostLineInput,
  ListPriceAmountInput,
  PatchArticleBody,
  UpsertArticleBody,
} from "./schema.js"

type MutateResult =
  | { success: true; articleId?: string }
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

async function buildCostReplaceOps(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  lines: CostLineInput[],
  existingIds: string[],
): Promise<{ ok: true; ops: AuditOp[] } | { ok: false; error: string }> {
  const validated = validateArticleCostLines(lines)
  if (!validated.ok) return validated
  const ops: AuditOp[] = existingIds.map((id) => ({
    op: "delete",
    table: "article_costs",
    id,
  }))
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
  for (const [index, line] of normalized.entries()) {
    ops.push({
      op: "insert",
      table: "article_costs",
      row: {
        id: randomUUID(),
        pop_id: popId,
        article_id: articleId,
        supplier_id: line.supplierId?.trim() || null,
        name: (line.name ?? "").trim(),
        cost_unit_label: line.costUnitLabel.trim(),
        sale_units_per_cost_unit: line.saleUnitsPerCostUnit,
        unit_price: line.unitPrice,
        is_active: line.isActive !== false,
        sort_order: index,
      },
    })
  }
  return { ok: true, ops }
}

async function buildListPriceOps(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  inputs: ListPriceAmountInput[],
): Promise<{ ok: true; ops: AuditOp[] } | { ok: false; error: string }> {
  const { data: extraLists, error: listsError } = await supabase
    .from("price_lists")
    .select("id")
    .eq("pop_id", popId)
    .eq("is_default", false)
  if (listsError) return { ok: false, error: listsError.message }
  const extraIds = new Set((extraLists ?? []).map((row) => String(row.id)))
  const wanted = inputs.filter((row) => extraIds.has(row.listId))
  const ops: AuditOp[] = []
  for (const row of wanted) {
    const { data: existing } = await supabase
      .from("price_list_items")
      .select("id")
      .eq("pop_id", popId)
      .eq("price_list_id", row.listId)
      .eq("item_kind", "article")
      .eq("item_id", articleId)
      .maybeSingle()
    if (row.amount == null) {
      if (existing?.id) {
        ops.push({ op: "delete", table: "price_list_items", id: String(existing.id) })
      }
      continue
    }
    if (existing?.id) {
      ops.push({
        op: "update",
        table: "price_list_items",
        id: String(existing.id),
        row: { amount: row.amount },
      })
    } else {
      ops.push({
        op: "insert",
        table: "price_list_items",
        row: {
          id: randomUUID(),
          pop_id: popId,
          price_list_id: row.listId,
          item_kind: "article",
          item_id: articleId,
          amount: row.amount,
        },
      })
    }
  }
  return { ok: true, ops }
}

export async function createArticle(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  userId: string,
  input: UpsertArticleBody,
  audit: MutationAuditCtx,
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

  const articleId = randomUUID()
  const articleRow = {
    id: articleId,
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
  }

  const ops: AuditOp[] = [{ op: "insert", table: "articles", row: articleRow }]
  const costOps = await buildCostReplaceOps(supabase, popId, articleId, costLines, [])
  if (!costOps.ok) return { success: false, error: costOps.error, status: 400 }
  ops.push(...costOps.ops)

  if (input.itemKind === "merchandise") {
    const listOps = await buildListPriceOps(
      supabase,
      popId,
      articleId,
      input.listPrices ?? [],
    )
    if (!listOps.ok) return { success: false, error: listOps.error, status: 400 }
    ops.push(...listOps.ops)
  }

  if (wantsInitial && initialUnitCostSaleUom != null) {
    const stockOps = await buildInitialStockLedgerOps(supabase, {
      popId,
      popSiteId,
      userId,
      articleId,
      articleName: input.name.trim(),
      quantity: initialQty,
      unitCostSaleUom: initialUnitCostSaleUom,
    })
    if (!stockOps.ok) return { success: false, error: stockOps.error, status: 400 }
    ops.push(...stockOps.ops)
  }

  const applied = await applyWithAudit(supabase, {
    kind: "articles.create",
    ctx: audit,
    popId,
    resourceId: articleId,
    previous: null,
    next: articleRow,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  return { success: true, articleId }
}

function articleToUpsertBody(row: ArticleRow): UpsertArticleBody {
  return {
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl ?? "",
    brand: row.brand,
    sku: row.sku ?? "",
    barcode: row.barcode ?? "",
    salePrice: row.salePrice,
    iva: row.iva,
    categoryId: row.categoryId,
    isActive: row.isActive,
    discountMode: row.discountMode,
    discountValue: row.discountValue,
    allowNegativeStock: row.allowNegativeStock,
    itemKind: row.itemKind,
    unitOfMeasure: row.unitOfMeasure,
    isSellable: row.isSellable,
    defaultWastePct: row.defaultWastePct,
    minStockLevel: row.minStockLevel,
    costs: row.costs.map((line) => ({
      name: line.name,
      costUnitLabel: line.costUnitLabel,
      saleUnitsPerCostUnit: line.saleUnitsPerCostUnit,
      unitPrice: line.unitPrice,
      supplierId: line.supplierId,
      isActive: line.isActive,
    })),
    listPrices: row.listPrices.map((line) => ({
      listId: line.listId,
      amount: line.amount,
    })),
  }
}

export async function updateArticle(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  articleId: string,
  patch: PatchArticleBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getArticle(supabase, popId, articleId)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(articleToUpsertBody(current.data), patch)

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
  const updateRow = {
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
  }

  const ops: AuditOp[] = [
    { op: "update", table: "articles", id: articleId, row: updateRow },
  ]
  if (patch.costs !== undefined) {
    const costOps = await buildCostReplaceOps(
      supabase,
      popId,
      articleId,
      patch.costs,
      current.data.costs.map((line) => line.id),
    )
    if (!costOps.ok) return { success: false, error: costOps.error, status: 400 }
    ops.push(...costOps.ops)
  }
  if (patch.listPrices !== undefined && input.itemKind === "merchandise") {
    const listOps = await buildListPriceOps(
      supabase,
      popId,
      articleId,
      patch.listPrices,
    )
    if (!listOps.ok) return { success: false, error: listOps.error, status: 400 }
    ops.push(...listOps.ops)
  }

  const applied = await applyWithAudit(supabase, {
    kind: "articles.patch",
    ctx: audit,
    popId,
    resourceId: articleId,
    previous: current.data,
    next: { ...current.data, ...input },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function deleteArticle(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  confirmationTyped: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getArticle(supabase, popId, articleId)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const expectedPhrase = articleDeleteConfirmPhrase(current.data.name)
  if (confirmationTyped.trim() !== expectedPhrase) {
    return {
      success: false,
      error: `Escribí (${expectedPhrase}) para confirmar el borrado.`,
      status: 400,
    }
  }
  const ops: AuditOp[] = current.data.costs.map((line) => ({
    op: "delete" as const,
    table: "article_costs",
    id: line.id,
  }))
  ops.push({ op: "delete", table: "articles", id: articleId })
  const applied = await applyWithAudit(supabase, {
    kind: "articles.delete",
    ctx: audit,
    popId,
    resourceId: articleId,
    previous: current.data,
    next: null,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
