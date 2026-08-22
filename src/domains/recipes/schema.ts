import { z } from "zod"

export const RECIPE_TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_RECIPE_TABLE_PAGE_SIZE = 25
export const RECIPE_TABLE_SORT_KEYS = [
  "name",
  "sale_price",
  "cost_price",
] as const
export const RECIPE_INGREDIENT_ITEM_KINDS = ["raw_material", "supply"] as const
export const RECIPE_INGREDIENT_SEARCH_LIMIT = 8

export type RecipeIngredientItemKind =
  (typeof RECIPE_INGREDIENT_ITEM_KINDS)[number]

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v == null ? undefined : v === "true" || v === "1"))

export const listRecipesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_RECIPE_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  soloActivos: boolQuery,
  categoryId: z.string().optional(),
  sort: z.enum(RECIPE_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type ListRecipesQuery = {
  page: number
  pageSize: number
  search: string
  soloActivos: boolean
  categoryId: string
  sort: string | null
  ord: "asc" | "desc"
}

export function toListRecipesQuery(
  parsed: z.infer<typeof listRecipesQuerySchema>,
): ListRecipesQuery {
  const pageSize = RECIPE_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof RECIPE_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_RECIPE_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    soloActivos: parsed.soloActivos === true,
    categoryId: /^[0-9a-f-]{36}$/i.test(parsed.categoryId?.trim() ?? "")
      ? parsed.categoryId!.trim()
      : "",
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export const listRecipeIngredientsQuerySchema = z.object({
  q: z.string().optional().default(""),
  ids: z.string().optional().default(""),
  exclude: z.string().optional().default(""),
})

export const ingredientInputSchema = z.object({
  articleId: z.string().uuid(),
  quantity: z.number(),
  wastePct: z.number().nullable(),
})

export const listPriceAmountSchema = z.object({
  listId: z.string().uuid(),
  amount: z.number().nullable(),
})

export const upsertRecipeBodySchema = z.object({
  name: z.string(),
  description: z.string().optional().default(""),
  imageUrl: z.string().optional().default(""),
  categoryId: z.string().uuid(),
  salePrice: z.number(),
  iva: z.number(),
  isActive: z.boolean(),
  allowNegativeStock: z.boolean(),
  ingredients: z.array(ingredientInputSchema).min(1),
  listPrices: z.array(listPriceAmountSchema).optional(),
})

export const deleteRecipeBodySchema = z.object({
  confirmationTyped: z.string(),
})

export type IngredientInput = z.infer<typeof ingredientInputSchema>
export type ListPriceAmountInput = z.infer<typeof listPriceAmountSchema>
export type UpsertRecipeBody = z.infer<typeof upsertRecipeBodySchema>

export type RecipeListPriceRow = {
  listId: string
  amount: number
}

export type RecipeIngredientOption = {
  id: string
  name: string
  itemKind: RecipeIngredientItemKind
  unitOfMeasure: string
  costPrice: number
  defaultWastePct: number | null
}

export type RecipeIngredientRow = {
  id: string
  articleId: string
  articleName: string
  itemKind: RecipeIngredientItemKind
  unitOfMeasure: string
  quantity: number
  wastePct: number | null
  articleCostPrice: number
  articleDefaultWastePct: number | null
  lineCost: number
}

export type RecipeRow = {
  id: string
  name: string
  description: string
  imageUrl: string | null
  categoryId: string | null
  categoryName: string
  salePrice: number
  costPrice: number
  iva: number
  ingredientCount: number
  isActive: boolean
  allowNegativeStock: boolean
  listPrices: RecipeListPriceRow[]
}

export type RecipeDetail = RecipeRow & {
  ingredients: RecipeIngredientRow[]
}

export type RecipeListData = {
  recipes: RecipeRow[]
  totalCount: number
  page: number
  pageSize: number
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}
