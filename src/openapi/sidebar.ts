type DocSection = "General" | "Operativas" | "Dominios"

type LeafTag = { name: string; description?: string }

type SidebarTag = {
  name: string
  description?: string
  "x-displayName"?: string
}

const SECTIONS: DocSection[] = ["General", "Operativas", "Dominios"]

const SECTION_DOMAINS: Record<DocSection, string[]> = {
  General: [
    "Me",
    "Salud",
    "Dock",
    "Ajustes",
    "Realtime",
    "Código de aprobación",
  ],
  Operativas: [
    "Venta",
    "Mostrador",
    "Mesas",
    "Comandas",
    "Catálogo de menú",
    "Gastos",
    "Inventario",
    "Producción",
    "Comprobantes",
    "Tesorería",
    "Reportes",
    "Estadísticas",
  ],
  Dominios: [
    "Auditoría",
    "RRHH",
    "Clientes",
    "Artículos",
    "Categorías",
    "Categorías de receta",
    "Recetas",
    "Promociones",
    "Servicios",
    "Categorías de servicio",
    "Categorías de gasto",
    "Proveedores",
    "Listas de precio",
    "Impresoras",
    "Estaciones de comanda",
    "Cuentas corrientes",
    "Presupuestos",
    "Órdenes de compra",
    "Operaciones",
    "Cajas",
    "Cheques",
    "Puntos de venta ARCA",
    "Chat",
  ],
}

const LEAF_DESCRIPTIONS: Record<string, string> = {
  Salud: "Liveness, sin autenticación.",
  Clientes: "ABM de clientes del local.",
  Artículos: "ABM de artículos, costos e imagen.",
  Categorías: "Categorías del catálogo de artículos.",
  Comprobantes: "Facturas y comprobantes ARCA.",
  Venta: "Catálogo y flujo de venta.",
  "Catálogo de menú": "Ítems visibles en menú / venta.",
  Mostrador: "Pedidos de mostrador.",
  Mesas: "Salón, sesiones y reservas.",
  Comandas: "Comandas de cocina / barra.",
}

/** Alias solo para el sidebar de Scalar. El tag de las rutas no cambia. */
const DISPLAY_NAMES: Record<string, string> = {
  Categorías: "Categorías de artículos",
}

function sidebarLabel(name: string) {
  return DISPLAY_NAMES[name] ?? name
}

function sortBySidebarLabel(names: string[]) {
  return [...names].sort((a, b) =>
    sidebarLabel(a).localeCompare(sidebarLabel(b), "es", { sensitivity: "base" }),
  )
}

export function buildOpenApiSidebar(extraTags: LeafTag[] = []) {
  const descriptions = new Map<string, string>(Object.entries(LEAF_DESCRIPTIONS))
  const present = new Set(extraTags.map((tag) => tag.name))
  for (const tag of extraTags) {
    if (tag.description) descriptions.set(tag.name, tag.description)
  }
  for (const name of Object.keys(LEAF_DESCRIPTIONS)) present.add(name)

  const assigned = new Set<string>()
  for (const section of SECTIONS) {
    for (const name of SECTION_DOMAINS[section]) assigned.add(name)
  }

  const leftovers = extraTags
    .map((tag) => tag.name)
    .filter((name) => !assigned.has(name))

  const tags: SidebarTag[] = []
  const tagGroups: { name: string; tags: string[] }[] = []

  for (const section of SECTIONS) {
    const names = sortBySidebarLabel([
      ...SECTION_DOMAINS[section].filter((name) => present.has(name)),
      ...(section === "General" ? leftovers : []),
    ])
    if (names.length === 0) continue
    tagGroups.push({ name: section, tags: names })
    for (const name of names) {
      tags.push({
        name,
        description: descriptions.get(name),
        ...(DISPLAY_NAMES[name]
          ? { "x-displayName": DISPLAY_NAMES[name] }
          : {}),
      })
    }
  }

  return {
    tags,
    "x-tagGroups": tagGroups,
  }
}
