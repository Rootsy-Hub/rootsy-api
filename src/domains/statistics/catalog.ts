import type { SupabaseClient } from "@supabase/supabase-js"
import {
  ARTICLE_ITEM_KINDS,
  type ArticleItemKind,
} from "../articles/schema.js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import type { SlimLine, SlimSale } from "./loaders.js"

const CHUNK = 400

export const COST_KIND_LABELS: Record<ArticleItemKind, string> = {
  merchandise: "Mercaderías",
  raw_material: "Materias primas",
  supply: "Insumos",
}

export const STOCK_KIND_LABELS: Record<ArticleItemKind, string> = {
  merchandise: "Producto",
  raw_material: "Materia prima",
  supply: "Insumo",
}

export function isArticleItemKind(value: string): value is ArticleItemKind {
  return (ARTICLE_ITEM_KINDS as readonly string[]).includes(value)
}

export type CategoryRef = { categoryId: string; categoryName: string }

export type ProductStatsBucket = {
  label: string
  articleId: string | null
  recipeId: string | null
  promotionId: string | null
  lineKind: SlimLine["lineKind"]
  revenue: number
  cost: number
  quantity: number
}

export const PROMOTION_CATEGORY_KEY = "promotion:all"
export const PROMOTION_CATEGORY_LABEL = "Promociones"

async function inChunks<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    await fetchChunk(ids.slice(i, i + CHUNK))
  }
}

export async function fetchArticleItemKindsById(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, ArticleItemKind>> {
  const kinds = new Map<string, ArticleItemKind>()
  const unique = [...new Set(articleIds.filter(Boolean))]
  await inChunks(unique, async (chunk) => {
    const { data } = await supabase
      .from("articles")
      .select("id, item_kind")
      .eq("pop_id", popId)
      .in("id", chunk)
    for (const row of data || []) {
      const kind = String(row.item_kind ?? "")
      if (isArticleItemKind(kind)) kinds.set(String(row.id), kind)
    }
  })
  return kinds
}

export async function fetchArticleCategoriesById(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, CategoryRef>> {
  const categories = new Map<string, CategoryRef>()
  const unique = [...new Set(articleIds.filter(Boolean))]
  await inChunks(unique, async (chunk) => {
    const { data } = await supabase
      .from("articles")
      .select("id, category_id, categories ( name )")
      .eq("pop_id", popId)
      .in("id", chunk)
    for (const row of data || []) {
      const category = row.categories as { name?: string } | null
      categories.set(String(row.id), {
        categoryId: String(row.category_id ?? "sin-categoria"),
        categoryName: category?.name?.trim() || "Sin categoría",
      })
    }
  })
  return categories
}

export async function fetchRecipeCategoriesById(
  supabase: SupabaseClient,
  popId: string,
  recipeIds: string[],
): Promise<Map<string, CategoryRef>> {
  const categories = new Map<string, CategoryRef>()
  const unique = [...new Set(recipeIds.filter(Boolean))]
  await inChunks(unique, async (chunk) => {
    const { data } = await supabase
      .from("recipes")
      .select("id, category_id, recipe_categories ( name )")
      .eq("pop_id", popId)
      .in("id", chunk)
    for (const row of data || []) {
      const category = row.recipe_categories as { name?: string } | null
      categories.set(String(row.id), {
        categoryId: String(row.category_id ?? "sin-categoria"),
        categoryName: category?.name?.trim() || "Sin categoría",
      })
    }
  })
  return categories
}

export async function fetchRecipeUnitCostsById(
  supabase: SupabaseClient,
  popId: string,
  recipeIds: string[],
): Promise<Map<string, number>> {
  const costs = new Map<string, number>()
  const unique = [...new Set(recipeIds.filter(Boolean))]
  await inChunks(unique, async (chunk) => {
    const { data } = await supabase
      .from("recipes")
      .select("id, cost_price")
      .eq("pop_id", popId)
      .in("id", chunk)
    for (const row of data || []) {
      const unitCost = parseMoney(row.cost_price)
      if (unitCost > 0) costs.set(String(row.id), unitCost)
    }
  })
  return costs
}

export function saleLineProductKey(item: SlimLine): string {
  if (item.articleId) return `a:${item.articleId}`
  if (item.recipeId) return `r:${item.recipeId}`
  if (item.promotionId) return `p:${item.promotionId}`
  const name = item.nameSnapshot.trim().toLowerCase() || "sin-nombre"
  return `n:${name}`
}

export function sumProductQuantitiesByKind(sales: SlimSale[]): {
  articles: number
  promotions: number
  recipes: number
} {
  const totals = { articles: 0, promotions: 0, recipes: 0 }
  for (const sale of sales) {
    for (const item of sale.lineItems) {
      if (item.lineTotal <= 0 && item.quantity <= 0) continue
      if (item.promotionId || item.lineKind === "promotion") {
        totals.promotions += item.quantity
      } else if (item.recipeId || item.lineKind === "recipe") {
        totals.recipes += item.quantity
      } else {
        totals.articles += item.quantity
      }
    }
  }
  return {
    articles: roundMoney(totals.articles),
    promotions: roundMoney(totals.promotions),
    recipes: roundMoney(totals.recipes),
  }
}

export function accumulateProductBuckets(
  sales: SlimSale[],
  buckets: Map<string, ProductStatsBucket>,
): void {
  for (const sale of sales) {
    for (const item of sale.lineItems) {
      if (item.lineTotal <= 0 && item.quantity <= 0) continue
      const key = saleLineProductKey(item)
      const prev = buckets.get(key)
      buckets.set(key, {
        label: prev?.label ?? (item.nameSnapshot.trim() || "Sin nombre"),
        articleId: item.articleId ?? prev?.articleId ?? null,
        recipeId: item.recipeId ?? prev?.recipeId ?? null,
        promotionId: item.promotionId ?? prev?.promotionId ?? null,
        lineKind: item.lineKind ?? prev?.lineKind ?? null,
        revenue: roundMoney((prev?.revenue ?? 0) + item.lineTotal),
        cost: prev?.cost ?? 0,
        quantity: roundMoney((prev?.quantity ?? 0) + item.quantity),
      })
    }
  }
}

export async function hydrateProductBucketCosts(
  supabase: SupabaseClient,
  popId: string,
  buckets: Map<string, ProductStatsBucket>,
): Promise<void> {
  const articleIds = [
    ...new Set(
      [...buckets.values()]
        .map((bucket) => bucket.articleId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  if (articleIds.length > 0) {
    const unitCosts = await resolveArticleReferenceUnitCostsByArticleId(
      supabase,
      popId,
      articleIds,
    )
    for (const bucket of buckets.values()) {
      if (!bucket.articleId || bucket.cost > 0) continue
      const unitCost = unitCosts.get(bucket.articleId) ?? 0
      if (unitCost > 0) {
        bucket.cost = roundMoney(unitCost * bucket.quantity)
      }
    }
  }

  const recipeIds = [
    ...new Set(
      [...buckets.values()]
        .map((bucket) => bucket.recipeId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  if (recipeIds.length === 0) return
  const recipeCosts = await fetchRecipeUnitCostsById(supabase, popId, recipeIds)
  for (const bucket of buckets.values()) {
    if (!bucket.recipeId || bucket.cost > 0) continue
    const unitCost = recipeCosts.get(bucket.recipeId) ?? 0
    if (unitCost > 0) {
      bucket.cost = roundMoney(unitCost * bucket.quantity)
    }
  }
}

export function resolveLineCategory(
  item: SlimLine,
  articleCategories: Map<string, CategoryRef>,
  recipeCategories: Map<string, CategoryRef>,
): { categoryKey: string; categoryLabel: string } {
  if (item.promotionId || item.lineKind === "promotion") {
    return {
      categoryKey: PROMOTION_CATEGORY_KEY,
      categoryLabel: PROMOTION_CATEGORY_LABEL,
    }
  }
  if (item.recipeId || item.lineKind === "recipe") {
    const category = item.recipeId ? recipeCategories.get(item.recipeId) : null
    return {
      categoryKey: `recipe:${category?.categoryId || "sin-categoria"}`,
      categoryLabel: category?.categoryName || "Sin categoría",
    }
  }
  if (item.articleId || item.lineKind === "article") {
    const category = item.articleId ? articleCategories.get(item.articleId) : null
    return {
      categoryKey: `article:${category?.categoryId || "sin-categoria"}`,
      categoryLabel: category?.categoryName || "Sin categoría",
    }
  }
  return {
    categoryKey: "other:sin-categoria",
    categoryLabel: "Sin categoría",
  }
}

export function resolveBucketCategory(
  bucket: ProductStatsBucket,
  articleCategories: Map<string, CategoryRef>,
  recipeCategories: Map<string, CategoryRef>,
): { categoryKey: string; categoryLabel: string } {
  return resolveLineCategory(
    {
      articleId: bucket.articleId,
      recipeId: bucket.recipeId,
      promotionId: bucket.promotionId,
      lineKind: bucket.lineKind,
      nameSnapshot: bucket.label,
      quantity: bucket.quantity,
      lineTotal: bucket.revenue,
      unitCost: 0,
    },
    articleCategories,
    recipeCategories,
  )
}

export function purchaseLineAmount(line: SlimLine): number {
  if (line.lineTotal > 0) return line.lineTotal
  return roundMoney(line.quantity * line.unitCost)
}

export function purchaseLineProductKey(line: SlimLine): string {
  if (line.articleId) return `a:${line.articleId}`
  const name = line.nameSnapshot.trim().toLowerCase() || "sin-nombre"
  return `n:${name}`
}
