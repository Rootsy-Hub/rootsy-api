export const CLIENT_IVA_CONDITION_VALUES = [
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "consumidor_final",
  "exento",
  "no_categorizado",
] as const

export type ClientIvaConditionValue =
  (typeof CLIENT_IVA_CONDITION_VALUES)[number]

export const CLIENT_IVA_CONDITION_OPTIONS: {
  value: ClientIvaConditionValue
  label: string
}[] = [
  { value: "responsable_inscripto", label: "Responsable inscripto" },
  { value: "monotributo", label: "Monotributo" },
  { value: "monotributo_social", label: "Monotributo social" },
  { value: "consumidor_final", label: "Consumidor final" },
  { value: "exento", label: "Exento" },
  { value: "no_categorizado", label: "Sin categorizar" },
]
