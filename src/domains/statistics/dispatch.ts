import type { SupabaseClient } from "@supabase/supabase-js"
import { getFinanceDetails, getFinanceSummary } from "./finance.js"
import { getInventoryDetails, getInventorySummary } from "./inventory.js"
import {
  getClientsDetails,
  getClientsSummary,
  getSuppliersDetails,
  getSuppliersSummary,
} from "./parties.js"
import {
  getProfitabilityDetails,
  getProfitabilitySummary,
} from "./profitability.js"
import { getProductsDetails, getProductsSummary } from "./products.js"
import { getPurchasesDetails, getPurchasesSummary } from "./purchases.js"
import { getSalesDetails, getSalesSummary } from "./sales.js"
import {
  placeholderSection,
  type SectionQuery,
  type StatisticsSectionData,
  type StatisticsSectionId,
} from "./schema.js"

type SectionResult =
  | { success: true; data: StatisticsSectionData }
  | { success: false; error: string }

const TITLES: Record<StatisticsSectionId, { title: string; description: string }> = {
  sales: { title: "Ventas", description: "" },
  profitability: {
    title: "Rentabilidad",
    description: "Margen, costos, gastos y resultado del período",
  },
  products: {
    title: "Productos",
    description: "Rentabilidad, participación y ventas por categoría",
  },
  purchases: {
    title: "Compras",
    description: "Importes, operaciones y principales compradores",
  },
  inventory: {
    title: "Inventario",
    description: "Stock actual, alertas y rotación de artículos",
  },
  clients: {
    title: "Clientes",
    description: "Activos, nuevos, recurrentes y ticket por cliente",
  },
  suppliers: {
    title: "Proveedores",
    description: "Compras, artículos y categorías por proveedor",
  },
  finance: {
    title: "Finanzas",
    description: "Ingresos, egresos, neto y margen en cuentas de tesorería",
  },
  services: {
    title: "Servicios",
    description: "Facturación y evolución de servicios vendidos",
  },
  manufacturing: {
    title: "Fabricación",
    description: "Producción, costos e insumos consumidos",
  },
}

export function isComingSoonSection(sectionId: StatisticsSectionId): boolean {
  return sectionId === "services" || sectionId === "manufacturing"
}

export async function getStatisticsSection(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  sectionId: StatisticsSectionId,
  kind: "summary" | "details",
  query: SectionQuery,
): Promise<SectionResult> {
  if (isComingSoonSection(sectionId)) {
    const meta = TITLES[sectionId]
    return {
      success: true,
      data: placeholderSection(sectionId, meta.title, meta.description),
    }
  }

  switch (sectionId) {
    case "sales":
      return kind === "summary"
        ? getSalesSummary(supabase, popId, popSiteId, query)
        : getSalesDetails(supabase, popId, popSiteId, query)
    case "profitability":
      return kind === "summary"
        ? getProfitabilitySummary(supabase, popId, query)
        : getProfitabilityDetails(supabase, popId, popSiteId, query)
    case "products":
      return kind === "summary"
        ? getProductsSummary(supabase, popId, popSiteId, query)
        : getProductsDetails(supabase, popId, popSiteId, query)
    case "purchases":
      return kind === "summary"
        ? getPurchasesSummary(supabase, popId, popSiteId, query)
        : getPurchasesDetails(supabase, popId, popSiteId, query)
    case "inventory":
      return kind === "summary"
        ? getInventorySummary(supabase, popId, query)
        : getInventoryDetails(supabase, popId, query)
    case "clients":
      return kind === "summary"
        ? getClientsSummary(supabase, popId, popSiteId, query)
        : getClientsDetails(supabase, popId, popSiteId, query)
    case "suppliers":
      return kind === "summary"
        ? getSuppliersSummary(supabase, popId, popSiteId, query)
        : getSuppliersDetails(supabase, popId, popSiteId, query)
    case "finance":
      return kind === "summary"
        ? getFinanceSummary(supabase, popId, popSiteId, query)
        : getFinanceDetails(supabase, popId, popSiteId, query)
    default:
      return { success: false, error: "Sección no disponible" }
  }
}
