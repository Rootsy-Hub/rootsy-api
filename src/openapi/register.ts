import { Scalar } from "@scalar/hono-api-reference"
import type { OpenAPIHono } from "@hono/zod-openapi"
import type { Env } from "hono"
import { buildOpenApiSidebar } from "./sidebar.js"

export function registerOpenApiDocs<E extends Env>(
  app: OpenAPIHono<E>,
  extraTags: { name: string; description?: string }[] = [],
) {
  app.openAPIRegistry.registerComponent("securitySchemes", "ApiSecret", {
    type: "apiKey",
    in: "header",
    name: "x-rootsy-api-secret",
    description: "Secret compartido entre rootsy-web y rootsy-api.",
  })
  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Access token de Supabase Auth.",
  })

  app.doc31("/openapi.json", (c) => {
    const sidebar = buildOpenApiSidebar(extraTags)
    return {
      openapi: "3.1.0",
      info: {
        title: "Rootsy API",
        version: "0.1.0",
        description:
          "API privada de Rootsy. El spec OpenAPI 3.1 se arma desde el código. El sidebar agrupa por sección: General, Operativas y Dominios.",
      },
      tags: sidebar.tags,
      "x-tagGroups": sidebar["x-tagGroups"],
      servers: [
        {
          url: new URL(c.req.url).origin,
          description: "Este entorno",
        },
      ],
    }
  })

  app.get(
    "/docs",
    Scalar({
      url: "/openapi.json",
      pageTitle: "Rootsy API",
      theme: "fastify",
      layout: "modern",
      showSidebar: true,
      hideClientButton: false,
      hideModels: false,
      hideSearch: false,
      hideTestRequestButton: false,
      hideDarkModeToggle: false,
      showOperationId: false,
      withDefaultFonts: true,
      operationTitleSource: "summary",
      persistAuth: false,
      isEditable: false,
      documentDownloadType: "both",
      defaultOpenFirstTag: true,
      defaultOpenAllTags: false,
      expandAllModelSections: false,
      expandAllResponses: false,
      expandAllSchemaProperties: false,
      orderSchemaPropertiesBy: "alpha",
      orderRequiredPropertiesFirst: true,
      showDeveloperTools: "localhost",
    }),
  )
}
