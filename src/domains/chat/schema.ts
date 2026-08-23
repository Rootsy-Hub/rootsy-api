import { z } from "zod"

export const CHAT_CHANNEL_LIMIT = 8

const imageUrlField = z.string().max(2000).nullable().optional()

export const createChannelBodySchema = z.object({
  title: z.string().trim().min(1, "El nombre es obligatorio.").max(48),
  subtitle: z.string().max(80).optional().nullable(),
  imageUrl: imageUrlField,
  userIds: z.array(z.string().uuid()).min(1, "Elegí al menos una persona."),
})

export const updateChannelBodySchema = z.object({
  title: z.string().trim().min(1).max(48).optional(),
  subtitle: z.string().max(80).optional().nullable(),
  imageUrl: imageUrlField,
  userIds: z.array(z.string().uuid()).min(1).optional(),
})

export const sendMessageBodySchema = z.object({
  body: z.string().trim().min(1, "Escribí un mensaje.").max(2000),
})

export const CHAT_MESSAGE_PAGE_SIZE = 40

export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(80).optional(),
  before: z.string().min(8).max(64).optional(),
  beforeId: z.string().uuid().optional(),
})

export type CreateChannelBody = z.infer<typeof createChannelBodySchema>
export type UpdateChannelBody = z.infer<typeof updateChannelBodySchema>
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>

export type ChatEligibleUser = {
  userId: string
  firstName: string
  lastName: string
  roleId: string
  roleDisplayName: string
}

export type ChatRoleOption = {
  id: string
  displayName: string
}

export type ChatChannelListItem = {
  id: string
  slug: string
  title: string
  subtitle: string | null
  imageUrl: string | null
  initials: string
  isEquipo: boolean
  lastMessageAt: string | null
  lastMessageBody: string | null
  unread: number
  memberCount: number
}

export type ChatMessageRow = {
  id: string
  authorUserId: string
  authorName: string
  body: string
  createdAt: string
  mine: boolean
}

export type ChatWorkspaceData = {
  currentUserId: string
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
  channelCount: number
  channelLimit: number
  channels: ChatChannelListItem[]
  members: ChatEligibleUser[]
  roles: ChatRoleOption[]
}

export type ChatChannelDetailData = {
  channel: ChatChannelListItem
  memberUserIds: string[]
}

export type ChatMessageCursor = {
  createdAt: string
  id: string
}

export type ChatMessagesPage = {
  messages: ChatMessageRow[]
  hasMore: boolean
  nextCursor: ChatMessageCursor | null
}
