import { z } from "@hono/zod-openapi"

export const apiErrorSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
  })
  .openapi("ApiError")

export function jsonError(description: string) {
  return {
    content: {
      "application/json": { schema: apiErrorSchema },
    },
    description,
  }
}

export const mutationHeadersSchema = z.object({
  "x-rootsy-approver-user-id": z.string().optional().openapi({
    description:
      "Usuario que aprueba cuando el requester solo tiene :request_approval.",
  }),
  "x-rootsy-approval-code": z.string().optional().openapi({
    description: "Código de aprobación del aprobador.",
  }),
  "x-rootsy-execution": z.string().optional().openapi({
    description:
      "HMAC de Rootsy IA (ROOTSY_AI_EXECUTION_SECRET). Distinto del secret de API.",
  }),
})

export const popIdParamSchema = z.object({
  popId: z.string().uuid().openapi({
    param: { name: "popId", in: "path" },
    example: "32851b60-7fc4-4a00-87b5-27dab1739a4a",
  }),
})

export const mutateOkResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .openapi("MutateOk")

export const apiOkResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .openapi("ApiOk")

export function okDataSchema<T extends z.ZodType>(data: T, name: string) {
  return z
    .object({
      success: z.literal(true),
      data,
    })
    .openapi(name)
}

export const authSecurity: { ApiSecret: string[]; BearerAuth: string[] }[] = [
  { ApiSecret: [], BearerAuth: [] },
]
