import { z } from "@hono/zod-openapi"
import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Env } from "hono"
import { jsonError, mutationHeadersSchema } from "./schemas.js"

const genericJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .openapi("JsonObject")

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"])

type OpenApiMethod = "get" | "post" | "put" | "patch" | "delete"

type TagDef = { name: string; description: string }

const RESOURCE_TAGS: Record<string, TagDef> = {
  salud: { name: "Salud", description: "Liveness, sin autenticación." },
  me: { name: "Me", description: "Usuario autenticado y locales." },
  "approval-code": {
    name: "Código de aprobación",
    description: "Código para mutaciones delegadas.",
  },
  audit: { name: "Auditoría", description: "Rastro de cambios del local." },
  articles: { name: "Artículos", description: "ABM de artículos, costos e imagen." },
  categories: {
    name: "Categorías",
    description: "Categorías del catálogo de artículos.",
  },
  clients: { name: "Clientes", description: "ABM de clientes del local." },
  "comanda-stations": {
    name: "Estaciones de comanda",
    description: "Estaciones de cocina / barra.",
  },
  dock: { name: "Dock", description: "Accesos rápidos del local." },
  "price-lists": { name: "Listas de precio", description: "Listas de precio." },
  "expense-categories": {
    name: "Categorías de gasto",
    description: "Rubros de gastos.",
  },
  expenses: { name: "Gastos", description: "Gastos del local." },
  "recipe-categories": {
    name: "Categorías de receta",
    description: "Rubros de recetas.",
  },
  printers: { name: "Impresoras", description: "Impresoras del local." },
  promotions: { name: "Promociones", description: "Promociones y descuentos." },
  recipes: { name: "Recetas", description: "Recetas y costos." },
  "service-categories": {
    name: "Categorías de servicio",
    description: "Rubros de servicios.",
  },
  services: { name: "Servicios", description: "Servicios vendibles." },
  suppliers: { name: "Proveedores", description: "ABM de proveedores." },
  invoices: { name: "Comprobantes", description: "Facturas y comprobantes ARCA." },
  "arca-sale-points": {
    name: "Puntos de venta ARCA",
    description: "Puntos de venta fiscales.",
  },
  quotes: { name: "Presupuestos", description: "Presupuestos a clientes." },
  "purchase-orders": {
    name: "Órdenes de compra",
    description: "Órdenes a proveedores.",
  },
  checks: { name: "Cheques", description: "Cheques propios y de terceros." },
  "current-accounts": {
    name: "Cuentas corrientes",
    description: "Cuentas corrientes de clientes.",
  },
  inventory: { name: "Inventario", description: "Stock, depósitos y movimientos." },
  operations: { name: "Operaciones", description: "Historial de operaciones." },
  reports: { name: "Reportes", description: "Reportes del local." },
  "cash-registers": { name: "Cajas", description: "Cajas y sesiones de caja." },
  statistics: { name: "Estadísticas", description: "Métricas del local." },
  treasury: { name: "Tesorería", description: "Cuentas, marcas y conciliación." },
  settings: { name: "Ajustes", description: "Configuración del local." },
  hr: { name: "RRHH", description: "Equipo, roles, fichaje y pagos." },
  manufacturing: { name: "Producción", description: "Elaboraciones." },
  chat: { name: "Chat", description: "Canales y mensajes del local." },
  sale: { name: "Venta", description: "Catálogo y flujo de venta." },
  sales: { name: "Ventas", description: "Cobro y persistencia de ventas." },
  "menu-catalog": {
    name: "Catálogo de menú",
    description: "Ítems visibles en menú / venta.",
  },
  mostrador: { name: "Mostrador", description: "Pedidos de mostrador." },
  mesas: { name: "Mesas", description: "Salón, sesiones y reservas." },
  comandas: { name: "Comandas", description: "Comandas de cocina / barra." },
  realtime: { name: "Realtime", description: "WebSocket y eventos en vivo." },
}

const SKIP_PATHS = new Set(["/docs", "/openapi.json"])

function toOpenApiPath(honoPath: string): string {
  return honoPath.replaceAll(/:([^/]+)/g, "{$1}")
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1)
  return path || "/"
}

function pathParamNames(openApiPath: string): string[] {
  return [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "")
}

function pathParamsSchema(names: string[]) {
  if (names.length === 0) return undefined
  const shape: Record<string, z.ZodType> = {}
  for (const name of names) {
    const asUuid = name === "popId" || /Id$/.test(name)
    const schema = asUuid ? z.string().uuid() : z.string().min(1)
    shape[name] = schema.openapi({
      param: { name, in: "path" },
    })
  }
  return z.object(shape)
}

function resourceKey(openApiPath: string): string {
  if (openApiPath === "/health" || openApiPath === "/ping") return "salud"
  const parts = openApiPath.split("/").filter(Boolean)
  const popsIdx = parts.indexOf("pops")
  if (popsIdx >= 0) {
    const rest = parts.slice(popsIdx + 2)
    if (rest[0] === "me" && rest[1] === "approval-code") return "approval-code"
    if (rest[0]) return rest[0]
  }
  if (parts[0] === "v1" && parts[1] === "me") {
    return parts[2] === "approval-code" ? "approval-code" : "me"
  }
  if (parts[0] === "realtime") return "realtime"
  return parts.at(-1) ?? "api"
}

function tagFor(openApiPath: string): TagDef {
  const key = resourceKey(openApiPath)
  return (
    RESOURCE_TAGS[key] ?? {
      name: key,
      description: `Rutas de ${key}.`,
    }
  )
}

function summaryFor(method: OpenApiMethod, openApiPath: string): string {
  const parts = openApiPath.split("/").filter(Boolean)
  const last = parts.at(-1) ?? openApiPath
  const isParam = last.startsWith("{")
  const leaf = isParam ? (parts.at(-2) ?? last) : last
  if (openApiPath.includes("/realtime/pops/") && method === "get") {
    return "WebSocket del local"
  }
  const verbs: Record<OpenApiMethod, string> = {
    get: isParam ? "Obtener" : "Listar",
    post: "Crear",
    put: "Reemplazar",
    patch: "Actualizar",
    delete: "Eliminar",
  }
  return `${verbs[method]} ${leaf}`
}

function alreadyDocumented<E extends Env>(app: OpenAPIHono<E>): Set<string> {
  const keys = new Set<string>()
  for (const def of app.openAPIRegistry.definitions) {
    if (def.type !== "route") continue
    const method = String(def.route.method).toLowerCase()
    const path = normalizePath(def.route.path)
    keys.add(`${method} ${path}`)
  }
  return keys
}

export function catalogUndocumentedRoutes<E extends Env>(
  app: OpenAPIHono<E>,
): TagDef[] {
  const documented = alreadyDocumented(app)
  const tags = new Map<string, TagDef>()
  const seen = new Set<string>()

  for (const route of app.routes) {
    const method = route.method.toLowerCase()
    if (!HTTP_METHODS.has(method)) continue
    const honoPath = route.path
    if (honoPath.includes("*")) continue
    const openApiPath = normalizePath(toOpenApiPath(honoPath))
    if (SKIP_PATHS.has(openApiPath)) continue

    const key = `${method} ${openApiPath}`
    if (seen.has(key) || documented.has(key)) continue
    seen.add(key)

    const tag = tagFor(openApiPath)
    tags.set(tag.name, tag)
    const params = pathParamNames(openApiPath)
    const hasBody =
      method === "post" ||
      method === "put" ||
      method === "patch" ||
      method === "delete"
    const underPop = openApiPath.includes("/pops/{popId}/")
    const isWs =
      method === "get" && openApiPath.startsWith("/realtime/pops/{popId}")

    const paramsSchema = pathParamsSchema(params)
    const request: {
      params?: ReturnType<typeof pathParamsSchema>
      headers?: typeof mutationHeadersSchema
      body?: {
        required: false
        content: { "application/json": { schema: typeof genericJsonObjectSchema } }
      }
    } = {}
    if (paramsSchema) request.params = paramsSchema
    if (hasBody && underPop && !isWs) request.headers = mutationHeadersSchema
    if (hasBody && !isWs) {
      request.body = {
        required: false,
        content: {
          "application/json": { schema: genericJsonObjectSchema },
        },
      }
    }

    app.openAPIRegistry.registerPath({
      method: method as OpenApiMethod,
      path: openApiPath,
      tags: [tag.name],
      summary: summaryFor(method as OpenApiMethod, openApiPath),
      description: isWs
        ? "Upgrade WebSocket. No es JSON."
        : "Catálogo automático desde las rutas. Body y query detallados: Clientes, Artículos, Categorías, Comprobantes, Venta, Catálogo de menú, Mostrador, Mesas y Comandas.",
      ...(openApiPath.startsWith("/v1")
        ? { security: [{ ApiSecret: [], BearerAuth: [] }] }
        : {}),
      request,
      responses: {
        200: { description: "OK" },
        ...(openApiPath.startsWith("/v1")
          ? {
              400: jsonError("Pedido inválido."),
              401: jsonError("Falta secret o JWT."),
              403: jsonError("Sin permiso."),
            }
          : {}),
      },
    })
  }

  return [...tags.values()]
}
