import type { SupabaseClient } from "@supabase/supabase-js"
import {
  SERVICE_ARTICLE_ITEM_KINDS,
  billingPeriodDisplayLabel,
  isServiceArticleItemKind,
  isServiceBillingPeriod,
  isServiceDiscountMode,
  isServiceLateInterestType,
  isServicePaymentTiming,
  normalizeStoredUnitOfMeasure,
  parseServiceDetailsGrid,
  serviceDetailsGridHasContent,
  type ServiceArticleItemKind,
  type ServiceBillingPeriod,
  type ServiceDiscountMode,
  type ServiceLateInterestType,
  type ServicePaymentTiming,
} from "./catalog.js"
import {
  SERVICE_ARTICLE_SEARCH_LIMIT,
  type ListServicesQuery,
  type ServiceAddonRow,
  type ServiceArticleOption,
  type ServiceArticleRow,
  type ServiceDetail,
  type ServiceListData,
  type ServiceRow,
} from "./schema.js"

const SERVICE_SELECT = `
  id,
  pop_id,
  category_id,
  name,
  description,
  image_url,
  default_price,
  billing_period,
  billing_period_label,
  details_grid,
  contract_text,
  payment_timing,
  due_days_after,
  late_interest_type,
  late_interest_value,
  discount_mode,
  discount_value,
  is_active,
  service_categories ( name )
`

const SERVICE_LIST_SORT: Record<string, string> = {
  name: "name",
  default_price: "default_price",
  billing_period: "billing_period",
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function mapServiceRow(row: Record<string, unknown>): ServiceRow {
  const cat = row.service_categories as { name?: string } | null
  const billingPeriodRaw = String(row.billing_period ?? "monthly")
  const billingPeriod: ServiceBillingPeriod = isServiceBillingPeriod(
    billingPeriodRaw,
  )
    ? billingPeriodRaw
    : "monthly"
  const billingPeriodLabel =
    typeof row.billing_period_label === "string" &&
    row.billing_period_label.trim()
      ? row.billing_period_label.trim()
      : null
  const detailsGrid = parseServiceDetailsGrid(row.details_grid)
  const contractText =
    typeof row.contract_text === "string" ? row.contract_text.trim() : ""
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    imageUrl:
      typeof row.image_url === "string" && row.image_url.trim()
        ? row.image_url.trim()
        : null,
    categoryId: row.category_id ? String(row.category_id) : null,
    categoryName: cat?.name ? String(cat.name) : "—",
    defaultPrice: Number(row.default_price ?? 0) || 0,
    billingPeriod,
    billingPeriodLabel,
    billingPeriodDisplay: billingPeriodDisplayLabel(
      billingPeriod,
      billingPeriodLabel,
    ),
    detailCount: serviceDetailsGridHasContent(detailsGrid)
      ? detailsGrid.rows.length
      : 0,
    contractHasText: contractText.length > 0,
    articleCount: 0,
    isActive: Boolean(row.is_active),
  }
}

function mapArticleLine(
  row: Record<string, unknown>,
): ServiceArticleRow {
  const article = row.articles as {
    name?: string
    item_kind?: string
    unit_of_measure?: string
  } | null
  const rawKind = String(article?.item_kind ?? "raw_material")
  const itemKind: ServiceArticleItemKind = isServiceArticleItemKind(rawKind)
    ? rawKind
    : "raw_material"
  return {
    id: String(row.id),
    articleId: String(row.article_id),
    articleName: String(article?.name ?? "—"),
    quantity: Number(row.quantity ?? 0) || 0,
    unitOfMeasure: normalizeStoredUnitOfMeasure(
      String(article?.unit_of_measure ?? "u"),
      "u",
    ),
    itemKind,
  }
}

async function loadServiceTypeArticles(
  supabase: SupabaseClient,
  popId: string,
  serviceTypeId: string,
): Promise<ServiceArticleRow[]> {
  const { data, error } = await supabase
    .from("service_type_articles")
    .select(
      `
      id,
      article_id,
      quantity,
      articles ( name, item_kind, unit_of_measure )
    `,
    )
    .eq("pop_id", popId)
    .eq("service_type_id", serviceTypeId)
    .order("sort_order", { ascending: true })
  if (error) return []
  return (data ?? []).map((row) => mapArticleLine(row as Record<string, unknown>))
}

async function loadServiceTypeAddonArticles(
  supabase: SupabaseClient,
  popId: string,
  addonIds: string[],
): Promise<Map<string, ServiceArticleRow[]>> {
  const byAddon = new Map<string, ServiceArticleRow[]>()
  if (addonIds.length === 0) return byAddon

  const { data, error } = await supabase
    .from("service_type_addon_articles")
    .select(
      `
      id,
      addon_id,
      article_id,
      quantity,
      sort_order,
      articles ( name, item_kind, unit_of_measure )
    `,
    )
    .eq("pop_id", popId)
    .in("addon_id", addonIds)
    .order("sort_order", { ascending: true })
  if (error) return byAddon

  for (const row of data ?? []) {
    const addonId = String(row.addon_id)
    const line = mapArticleLine(row as Record<string, unknown>)
    const current = byAddon.get(addonId) ?? []
    current.push(line)
    byAddon.set(addonId, current)
  }
  return byAddon
}

async function loadServiceTypeAddons(
  supabase: SupabaseClient,
  popId: string,
  serviceTypeId: string,
): Promise<ServiceAddonRow[]> {
  const { data, error } = await supabase
    .from("service_type_addons")
    .select("id, name, price, sort_order")
    .eq("pop_id", popId)
    .eq("service_type_id", serviceTypeId)
    .order("sort_order", { ascending: true })
  if (error || !data?.length) return []

  const addonIds = data.map((row) => String(row.id))
  const articlesByAddon = await loadServiceTypeAddonArticles(
    supabase,
    popId,
    addonIds,
  )

  return data.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    price: Number(row.price ?? 0) || 0,
    sortOrder: Number(row.sort_order ?? 0) || 0,
    articles: articlesByAddon.get(String(row.id)) ?? [],
  }))
}

function mapServiceDetail(
  row: Record<string, unknown>,
  articles: ServiceArticleRow[],
  addons: ServiceAddonRow[],
): ServiceDetail {
  const base = mapServiceRow(row)
  const lateInterestRaw = String(row.late_interest_type ?? "none")
  const lateInterestType: ServiceLateInterestType = isServiceLateInterestType(
    lateInterestRaw,
  )
    ? lateInterestRaw
    : "none"
  const discountModeRaw = String(row.discount_mode ?? "none")
  const discountMode: ServiceDiscountMode = isServiceDiscountMode(discountModeRaw)
    ? discountModeRaw
    : "none"
  const paymentTimingRaw = String(row.payment_timing ?? "end_of_period")
  const paymentTiming: ServicePaymentTiming = isServicePaymentTiming(
    paymentTimingRaw,
  )
    ? paymentTimingRaw
    : "end_of_period"
  const dueDaysAfterRaw = row.due_days_after
  const dueDaysAfter =
    dueDaysAfterRaw == null || dueDaysAfterRaw === ""
      ? 0
      : Number(dueDaysAfterRaw)
  const lateInterestValueRaw = row.late_interest_value
  const lateInterestValue =
    lateInterestValueRaw == null || lateInterestValueRaw === ""
      ? null
      : Number(lateInterestValueRaw)
  const discountValueRaw = row.discount_value
  const discountValue =
    discountValueRaw == null || discountValueRaw === ""
      ? null
      : Number(discountValueRaw)
  return {
    ...base,
    articleCount: articles.length,
    detailsGrid: parseServiceDetailsGrid(row.details_grid),
    contractText:
      typeof row.contract_text === "string" ? row.contract_text : "",
    paymentTiming,
    dueDaysAfter:
      Number.isFinite(dueDaysAfter) && dueDaysAfter >= 0
        ? Math.min(365, Math.floor(dueDaysAfter))
        : 0,
    lateInterestType,
    lateInterestValue:
      lateInterestValue != null && Number.isFinite(lateInterestValue)
        ? lateInterestValue
        : null,
    discountMode,
    discountValue:
      discountValue != null && Number.isFinite(discountValue)
        ? discountValue
        : null,
    articles,
    addons,
  }
}

export async function listServices(
  supabase: SupabaseClient,
  popId: string,
  input: ListServicesQuery,
  caps: Pick<ServiceListData, "canCreate" | "canUpdate" | "canDelete">,
): Promise<
  { success: true; data: ServiceListData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("service_types")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .is("deleted_at", null)
  if (input.soloActivos) countQuery = countQuery.eq("is_active", true)
  if (input.categoryId) countQuery = countQuery.eq("category_id", input.categoryId)
  if (input.search) {
    const pattern = `%${escapeIlikeToken(input.search)}%`
    countQuery = countQuery.or(
      `name.ilike.${pattern},description.ilike.${pattern}`,
    )
  }

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize) || 1)
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const sortColumn = input.sort ? SERVICE_LIST_SORT[input.sort] : undefined
  const column = sortColumn ?? "name"
  const ascending = sortColumn ? input.ord === "asc" : true

  let dataQuery = supabase
    .from("service_types")
    .select(SERVICE_SELECT)
    .eq("pop_id", popId)
    .is("deleted_at", null)
  if (input.soloActivos) dataQuery = dataQuery.eq("is_active", true)
  if (input.categoryId) dataQuery = dataQuery.eq("category_id", input.categoryId)
  if (input.search) {
    const pattern = `%${escapeIlikeToken(input.search)}%`
    dataQuery = dataQuery.or(
      `name.ilike.${pattern},description.ilike.${pattern}`,
    )
  }
  dataQuery = dataQuery.order(column, { ascending }).range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      services: (data ?? []).map((row) =>
        mapServiceRow(row as Record<string, unknown>),
      ),
      totalCount,
      page,
      pageSize: input.pageSize,
      ...caps,
    },
  }
}

export async function getService(
  supabase: SupabaseClient,
  popId: string,
  serviceId: string,
): Promise<
  | { success: true; data: ServiceDetail }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("service_types")
    .select(SERVICE_SELECT)
    .eq("id", serviceId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "No se encontró el servicio.", status: 404 }
  }

  const [articles, addons] = await Promise.all([
    loadServiceTypeArticles(supabase, popId, serviceId),
    loadServiceTypeAddons(supabase, popId, serviceId),
  ])

  return {
    success: true,
    data: mapServiceDetail(data as Record<string, unknown>, articles, addons),
  }
}

export async function searchServiceArticles(
  supabase: SupabaseClient,
  popId: string,
  query: string,
  excludeIds: string[] = [],
  limit = SERVICE_ARTICLE_SEARCH_LIMIT,
): Promise<
  | { success: true; data: ServiceArticleOption[] }
  | { success: false; error: string }
> {
  const term = query.trim()
  if (!term) return { success: true, data: [] }

  const capped = Math.min(Math.max(1, limit), 20)
  const blocked = new Set(excludeIds.map((id) => id.trim()).filter(Boolean))
  const pattern = `%${escapeIlikeToken(term)}%`

  const { data, error } = await supabase
    .from("articles")
    .select("id, name, item_kind, unit_of_measure")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .in("item_kind", [...SERVICE_ARTICLE_ITEM_KINDS])
    .ilike("name", pattern)
    .order("name", { ascending: true })
    .limit(capped + blocked.size)

  if (error) return { success: false, error: error.message }

  const articles = (data ?? [])
    .map((row) => {
      const rawKind = String(row.item_kind ?? "raw_material")
      const itemKind: ServiceArticleItemKind = isServiceArticleItemKind(rawKind)
        ? rawKind
        : "raw_material"
      return {
        id: String(row.id),
        name: String(row.name ?? ""),
        itemKind,
        unitOfMeasure: normalizeStoredUnitOfMeasure(
          String(row.unit_of_measure ?? "u"),
          "u",
        ),
      }
    })
    .filter((row) => !blocked.has(row.id))
    .slice(0, capped)

  return { success: true, data: articles }
}
