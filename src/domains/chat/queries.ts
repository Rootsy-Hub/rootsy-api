import type { SupabaseClient } from "@supabase/supabase-js"
import { hasAnyPermission } from "../../sidecar/permissions.js"
import { CHAT_CREATE, CHAT_DELETE, CHAT_READ, CHAT_UPDATE } from "./allowlist.js"
import {
  CHAT_CHANNEL_LIMIT,
  CHAT_MESSAGE_PAGE_SIZE,
  type ChatChannelDetailData,
  type ChatChannelListItem,
  type ChatEligibleUser,
  type ChatMessageCursor,
  type ChatMessageRow,
  type ChatMessagesPage,
  type ChatRoleOption,
  type ChatWorkspaceData,
  type CreateChannelBody,
  type UpdateChannelBody,
} from "./schema.js"

function sameUserId(a: string, b: string): boolean {
  return (
    a.replace(/-/g, "").toLowerCase().trim() ===
    b.replace(/-/g, "").toLowerCase().trim()
  )
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const key = id.replace(/-/g, "").toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

function displayName(first: string, last: string): string {
  return `${first} ${last}`.replace(/\s+/g, " ").trim() || "Alguien"
}

function channelInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase()
  }
  return title.trim().slice(0, 2).toUpperCase() || "CH"
}

function slugify(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return base || "canal"
}

function asRoleRel(raw: unknown): { name?: string; display_name?: string } | null {
  if (!raw) return null
  const row = Array.isArray(raw) ? raw[0] : raw
  if (!row || typeof row !== "object") return null
  return row as { name?: string; display_name?: string }
}

function channelWriteError(message: string): string {
  if (/máximo 8|maximo 8/i.test(message)) {
    return "Este local ya tiene 8 canales."
  }
  if (/no se puede eliminar Equipo/i.test(message)) {
    return "Equipo no se puede eliminar."
  }
  if (/duplicate key|unique/i.test(message)) {
    return "Ya existe un canal con ese nombre."
  }
  return message
}

type ChannelDb = {
  id: string
  slug: string
  title: string
  subtitle: string | null
  image_url: string | null
  last_message_at: string | null
  last_message_body: string | null
}

type MessageDb = {
  id: string
  author_user_id: string
  author_name: string | null
  body: string | null
  created_at: string
}

function mapMessage(
  row: MessageDb,
  userId: string,
  imageUrl: string | null = null,
): ChatMessageRow {
  return {
    id: String(row.id),
    authorUserId: String(row.author_user_id),
    authorName: String(row.author_name ?? ""),
    authorImageUrl: imageUrl,
    body: String(row.body ?? ""),
    createdAt: String(row.created_at),
    mine: sameUserId(String(row.author_user_id), userId),
  }
}

async function loadUserImageUrls(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Record<string, string | null>> {
  const ids = uniqueIds(userIds)
  if (ids.length === 0) return {}
  const { data } = await supabase
    .from("users")
    .select("id, image_url")
    .in("id", ids)
  const map: Record<string, string | null> = {}
  for (const row of data || []) {
    const id = String(row.id)
    const url =
      row.image_url != null && String(row.image_url).trim()
        ? String(row.image_url)
        : null
    map[id] = url
    map[id.replace(/-/g, "").toLowerCase()] = url
  }
  return map
}

function imageUrlOf(
  map: Record<string, string | null>,
  userId: string,
): string | null {
  return map[userId] ?? map[userId.replace(/-/g, "").toLowerCase()] ?? null
}

function isOlderThanCursor(row: MessageDb, cursor: ChatMessageCursor): boolean {
  if (row.created_at < cursor.createdAt) return true
  return row.created_at === cursor.createdAt && String(row.id) < cursor.id
}

function mapChannel(
  row: ChannelDb,
  unread: number,
  memberCount: number,
): ChatChannelListItem {
  return {
    id: String(row.id),
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    subtitle: row.subtitle != null && String(row.subtitle).trim()
      ? String(row.subtitle)
      : null,
    imageUrl:
      row.image_url != null && String(row.image_url).trim()
        ? String(row.image_url)
        : null,
    initials: channelInitials(String(row.title ?? "")),
    isEquipo: String(row.slug ?? "") === "equipo",
    lastMessageAt: row.last_message_at ?? null,
    lastMessageBody: row.last_message_body != null
      ? String(row.last_message_body)
      : null,
    unread,
    memberCount,
  }
}

async function loadEligiblePeople(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; members: ChatEligibleUser[]; roles: ChatRoleOption[] }
  | { success: false; error: string; status: 500 }
> {
  const [{ data: roleRows, error: roleErr }, { data: uprRows, error: uprErr }, { data: pop }] =
    await Promise.all([
      supabase
        .from("roles")
        .select("id, display_name")
        .or(`pop_id.is.null,pop_id.eq.${popId}`)
        .order("display_name"),
      supabase
        .from("user_pop_roles")
        .select("user_id, role_id, is_active, roles:role_id ( display_name )")
        .eq("pop_id", popId),
      supabase.from("pops").select("owner_user_id").eq("id", popId).maybeSingle(),
    ])

  if (roleErr) return { success: false, error: roleErr.message, status: 500 }
  if (uprErr) return { success: false, error: uprErr.message, status: 500 }

  const active = (uprRows || []).filter((row) => row.is_active !== false)
  const userIds = [...new Set(active.map((row) => String(row.user_id)))]
  const ownerId =
    pop?.owner_user_id != null ? String(pop.owner_user_id) : null
  if (ownerId && !userIds.includes(ownerId)) userIds.push(ownerId)

  const profileMap: Record<
    string,
    { first_name: string; last_name: string; image_url: string | null }
  > = {}
  if (userIds.length > 0) {
    const [{ data: profiles }, { data: employeeRows }] = await Promise.all([
      supabase
        .from("users")
        .select("id, first_name, last_name, image_url")
        .in("id", userIds),
      supabase
        .from("pop_employees")
        .select("user_id, first_name, last_name, left_at")
        .eq("pop_id", popId)
        .in("user_id", userIds),
    ])
    for (const profile of profiles || []) {
      profileMap[String(profile.id)] = {
        first_name: profile.first_name ?? "",
        last_name: profile.last_name ?? "",
        image_url: profile.image_url ?? null,
      }
    }
    for (const employee of employeeRows || []) {
      if (!employee.user_id) continue
      const id = String(employee.user_id)
      const current = profileMap[id]
      const employeeName = {
        first_name: employee.first_name ?? "",
        last_name: employee.last_name ?? "",
      }
      const hasEmployeeName =
        employeeName.first_name.trim().length > 0 ||
        employeeName.last_name.trim().length > 0
      if (!hasEmployeeName) continue
      if (current && (current.first_name.trim() || current.last_name.trim()) && employee.left_at) {
        continue
      }
      profileMap[id] = {
        ...employeeName,
        image_url: current?.image_url ?? null,
      }
    }
  }

  const members: ChatEligibleUser[] = active.map((row) => {
    const rel = asRoleRel(row.roles)
    const prof = profileMap[String(row.user_id)] || {
      first_name: "",
      last_name: "",
      image_url: null,
    }
    return {
      userId: String(row.user_id),
      firstName: prof.first_name,
      lastName: prof.last_name,
      roleId: String(row.role_id ?? ""),
      roleDisplayName: rel?.display_name ?? "—",
      imageUrl: prof.image_url,
    }
  })

  if (ownerId && !members.some((member) => sameUserId(member.userId, ownerId))) {
    const prof = profileMap[ownerId] || {
      first_name: "",
      last_name: "",
      image_url: null,
    }
    members.unshift({
      userId: ownerId,
      firstName: prof.first_name,
      lastName: prof.last_name,
      roleId: "",
      roleDisplayName: "Propietario",
      imageUrl: prof.image_url,
    })
  }

  members.sort((a, b) =>
    displayName(a.firstName, a.lastName).localeCompare(
      displayName(b.firstName, b.lastName),
      "es",
    ),
  )

  const usedRoleIds = new Set(members.map((member) => member.roleId).filter(Boolean))
  const roles: ChatRoleOption[] = (roleRows || [])
    .filter((row) => usedRoleIds.has(String(row.id)))
    .map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name ?? ""),
    }))

  return { success: true, members, roles }
}

async function unreadByChannel(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  channels: ChannelDb[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (channels.length === 0) return out

  const { data: reads } = await supabase
    .from("pop_chat_channel_reads")
    .select("channel_id, last_read_at")
    .eq("pop_id", popId)
    .eq("user_id", userId)

  const readAt = new Map(
    (reads || []).map((row) => [String(row.channel_id), String(row.last_read_at)]),
  )

  await Promise.all(
    channels.map(async (channel) => {
      let q = supabase
        .from("pop_chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", channel.id)
        .neq("author_user_id", userId)
      const since = readAt.get(String(channel.id))
      if (since) q = q.gt("created_at", since)
      const { count } = await q
      out[String(channel.id)] = count ?? 0
    }),
  )
  return out
}

async function memberCounts(
  supabase: SupabaseClient,
  channelIds: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (channelIds.length === 0) return out
  const { data } = await supabase
    .from("pop_chat_channel_members")
    .select("channel_id")
    .in("channel_id", channelIds)
  for (const row of data || []) {
    const id = String(row.channel_id)
    out[id] = (out[id] ?? 0) + 1
  }
  return out
}

async function authorNameOf(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
): Promise<string> {
  const [{ data: employee }, { data: profile }] = await Promise.all([
    supabase
      .from("pop_employees")
      .select("first_name, last_name")
      .eq("pop_id", popId)
      .eq("user_id", userId)
      .is("left_at", null)
      .maybeSingle(),
    supabase
      .from("users")
      .select("first_name, last_name")
      .eq("id", userId)
      .maybeSingle(),
  ])
  const fromEmployee = displayName(employee?.first_name ?? "", employee?.last_name ?? "")
  if (fromEmployee !== "Alguien") return fromEmployee
  return displayName(profile?.first_name ?? "", profile?.last_name ?? "")
}

async function replaceMembers(
  supabase: SupabaseClient,
  popId: string,
  channelId: string,
  actorUserId: string,
  requestedIds: string[],
  eligibleIds: Set<string>,
): Promise<{ success: true } | { success: false; error: string; status: 400 | 500 }> {
  const next = uniqueIds([
    actorUserId,
    ...requestedIds.filter((id) => eligibleIds.has(id) || sameUserId(id, actorUserId)),
  ])
  if (next.length === 0) {
    return { success: false, error: "Elegí al menos una persona.", status: 400 }
  }

  const { data: current, error: curErr } = await supabase
    .from("pop_chat_channel_members")
    .select("user_id")
    .eq("channel_id", channelId)
  if (curErr) {
    return { success: false, error: curErr.message, status: 500 }
  }

  const currentIds = (current || []).map((row) => String(row.user_id))
  const nextSet = new Set(next.map((id) => id.replace(/-/g, "").toLowerCase()))
  const currentSet = new Set(currentIds.map((id) => id.replace(/-/g, "").toLowerCase()))

  const toAdd = next.filter((id) => !currentSet.has(id.replace(/-/g, "").toLowerCase()))
  const toRemove = currentIds.filter(
    (id) =>
      !nextSet.has(id.replace(/-/g, "").toLowerCase()) &&
      !sameUserId(id, actorUserId),
  )

  if (toAdd.length > 0) {
    const { error } = await supabase.from("pop_chat_channel_members").insert(
      toAdd.map((userId) => ({
        channel_id: channelId,
        pop_id: popId,
        user_id: userId,
      })),
    )
    if (error) return { success: false, error: error.message, status: 500 }
  }

  if (toRemove.length > 0) {
    const { error } = await supabase
      .from("pop_chat_channel_members")
      .delete()
      .eq("channel_id", channelId)
      .in("user_id", toRemove)
    if (error) return { success: false, error: error.message, status: 500 }
  }

  return { success: true }
}

export async function listChatChannelMemberIds(
  supabase: SupabaseClient,
  popId: string,
  channelId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("pop_chat_channel_members")
    .select("user_id")
    .eq("pop_id", popId)
    .eq("channel_id", channelId)
  if (error || !data) return []
  return uniqueIds(data.map((row) => String(row.user_id)))
}

export async function getChatWorkspace(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  keys: string[],
  isOwner: boolean,
): Promise<
  | { success: true; data: ChatWorkspaceData }
  | { success: false; error: string; status: 500 }
> {
  const people = await loadEligiblePeople(supabase, popId)
  if (!people.success) return people

  const [{ data: rows, error }, { data: countRaw }] = await Promise.all([
    supabase
      .from("pop_chat_channels")
      .select("id, slug, title, subtitle, image_url, last_message_at, last_message_body")
      .eq("pop_id", popId)
      .order("sort_order", { ascending: true })
      .order("title", { ascending: true }),
    supabase.rpc("pop_chat_channel_count", { p_pop_id: popId }),
  ])

  if (error) {
    return { success: false, error: error.message, status: 500 }
  }

  const channels = (rows || []) as ChannelDb[]
  const [unreads, counts] = await Promise.all([
    unreadByChannel(supabase, popId, userId, channels),
    memberCounts(
      supabase,
      channels.map((row) => String(row.id)),
    ),
  ])

  const channelCount = Number(countRaw ?? channels.length) || channels.length

  return {
    success: true,
    data: {
      currentUserId: userId,
      canCreate: hasAnyPermission(keys, [...CHAT_READ, ...CHAT_CREATE], isOwner),
      canUpdate: hasAnyPermission(keys, [...CHAT_READ, ...CHAT_UPDATE], isOwner),
      canDelete: hasAnyPermission(keys, CHAT_DELETE, isOwner),
      channelCount,
      channelLimit: CHAT_CHANNEL_LIMIT,
      channels: channels.map((row) =>
        mapChannel(row, unreads[String(row.id)] ?? 0, counts[String(row.id)] ?? 0),
      ),
      members: people.members,
      roles: people.roles,
    },
  }
}

export async function getChatChannel(
  supabase: SupabaseClient,
  popId: string,
  _userId: string,
  channelId: string,
): Promise<
  | { success: true; data: ChatChannelDetailData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: row, error } = await supabase
    .from("pop_chat_channels")
    .select("id, slug, title, subtitle, image_url, last_message_at, last_message_body")
    .eq("pop_id", popId)
    .eq("id", channelId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!row) return { success: false, error: "Canal no encontrado.", status: 404 }

  const { data: members, error: memErr } = await supabase
    .from("pop_chat_channel_members")
    .select("user_id")
    .eq("channel_id", channelId)

  if (memErr) return { success: false, error: memErr.message, status: 500 }

  const memberUserIds = (members || []).map((item) => String(item.user_id))
  const mapped = mapChannel(row as ChannelDb, 0, memberUserIds.length)

  return {
    success: true,
    data: {
      channel: mapped,
      memberUserIds,
    },
  }
}

export async function listChatMessages(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  channelId: string,
  input: { limit?: number; before?: string; beforeId?: string },
): Promise<
  | { success: true; data: ChatMessagesPage }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: channel, error: channelErr } = await supabase
    .from("pop_chat_channels")
    .select("id")
    .eq("pop_id", popId)
    .eq("id", channelId)
    .maybeSingle()

  if (channelErr) return { success: false, error: channelErr.message, status: 500 }
  if (!channel) return { success: false, error: "Canal no encontrado.", status: 404 }

  const limit = input.limit ?? CHAT_MESSAGE_PAGE_SIZE
  const cursor =
    input.before && input.beforeId
      ? { createdAt: input.before, id: input.beforeId }
      : input.before
        ? { createdAt: input.before, id: "" }
        : null

  let query = supabase
    .from("pop_chat_messages")
    .select("id, author_user_id, author_name, body, created_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1)

  if (cursor) {
    query = query.lte("created_at", cursor.createdAt)
  }

  const { data, error } = await query
  if (error) return { success: false, error: error.message, status: 500 }

  const rows = ((data || []) as MessageDb[]).filter((row) =>
    cursor ? isOlderThanCursor(row, cursor) : true,
  )
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const pageMessages = [...page].reverse()
  const imageMap = await loadUserImageUrls(
    supabase,
    pageMessages.map((row) => String(row.author_user_id)),
  )
  const messages = pageMessages.map((row) =>
    mapMessage(row, userId, imageUrlOf(imageMap, String(row.author_user_id))),
  )
  const oldest = messages[0] ?? null

  return {
    success: true,
    data: {
      messages,
      hasMore,
      nextCursor:
        hasMore && oldest
          ? { createdAt: oldest.createdAt, id: oldest.id }
          : null,
    },
  }
}

export async function createChatChannel(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: CreateChannelBody,
): Promise<
  | { success: true; data: { id: string } }
  | { success: false; error: string; status: 400 | 409 | 500 }
> {
  const { data: countRaw } = await supabase.rpc("pop_chat_channel_count", {
    p_pop_id: popId,
  })
  if (Number(countRaw ?? 0) >= CHAT_CHANNEL_LIMIT) {
    return { success: false, error: "Este local ya tiene 8 canales.", status: 409 }
  }

  const people = await loadEligiblePeople(supabase, popId)
  if (!people.success) return people
  const eligible = new Set(people.members.map((member) => member.userId))

  const title = input.title.trim()
  const subtitle = input.subtitle?.trim() ? input.subtitle.trim() : null
  const imageUrl = input.imageUrl?.trim() ? input.imageUrl.trim() : null
  let slug = slugify(title)
  if (slug === "equipo") slug = "canal-equipo"

  const { data: existing } = await supabase
    .from("pop_chat_channels")
    .select("slug")
    .eq("pop_id", popId)
  const taken = new Set((existing || []).map((row) => String(row.slug)))
  if (taken.has(slug)) {
    let n = 2
    while (taken.has(`${slug}-${n}`)) n += 1
    slug = `${slug}-${n}`
  }

  const { data: created, error } = await supabase
    .from("pop_chat_channels")
    .insert({
      pop_id: popId,
      slug,
      title,
      subtitle,
      image_url: imageUrl,
      sort_order: 10,
    })
    .select("id")
    .single()

  if (error || !created) {
    return {
      success: false,
      error: channelWriteError(error?.message || "No se pudo crear el canal."),
      status: 500,
    }
  }

  const channelId = String(created.id)
  const { error: selfErr } = await supabase.from("pop_chat_channel_members").insert({
    channel_id: channelId,
    pop_id: popId,
    user_id: userId,
  })
  if (selfErr) {
    await supabase.from("pop_chat_channels").delete().eq("id", channelId)
    return { success: false, error: selfErr.message, status: 500 }
  }

  const replaced = await replaceMembers(
    supabase,
    popId,
    channelId,
    userId,
    input.userIds,
    eligible,
  )
  if (!replaced.success) {
    await supabase.from("pop_chat_channels").delete().eq("id", channelId)
    return replaced
  }

  return { success: true, data: { id: channelId } }
}

export async function updateChatChannel(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  channelId: string,
  input: UpdateChannelBody,
): Promise<{ success: true } | { success: false; error: string; status: 400 | 404 | 500 }> {
  const { data: row, error } = await supabase
    .from("pop_chat_channels")
    .select("id, slug")
    .eq("pop_id", popId)
    .eq("id", channelId)
    .maybeSingle()
  if (error) return { success: false, error: error.message, status: 500 }
  if (!row) return { success: false, error: "Canal no encontrado.", status: 404 }

  const isEquipo = String(row.slug) === "equipo"
  const patch: Record<string, unknown> = {}
  if (!isEquipo && input.title != null) patch.title = input.title.trim()
  if (input.subtitle !== undefined) {
    patch.subtitle = input.subtitle?.trim() ? input.subtitle.trim() : null
  }
  if (input.imageUrl !== undefined) {
    patch.image_url = input.imageUrl?.trim() ? input.imageUrl.trim() : null
  }
  if (Object.keys(patch).length > 0) {
    const { error: updErr } = await supabase
      .from("pop_chat_channels")
      .update(patch)
      .eq("id", channelId)
      .eq("pop_id", popId)
    if (updErr) {
      return { success: false, error: channelWriteError(updErr.message), status: 500 }
    }
  }

  if (input.userIds) {
    const people = await loadEligiblePeople(supabase, popId)
    if (!people.success) return people
    const eligible = new Set(people.members.map((member) => member.userId))
    const replaced = await replaceMembers(
      supabase,
      popId,
      channelId,
      userId,
      input.userIds,
      eligible,
    )
    if (!replaced.success) return replaced
  }

  return { success: true }
}

export async function deleteChatChannel(
  supabase: SupabaseClient,
  popId: string,
  channelId: string,
): Promise<{ success: true } | { success: false; error: string; status: 404 | 409 | 500 }> {
  const { data: row, error } = await supabase
    .from("pop_chat_channels")
    .select("id, slug")
    .eq("pop_id", popId)
    .eq("id", channelId)
    .maybeSingle()
  if (error) return { success: false, error: error.message, status: 500 }
  if (!row) return { success: false, error: "Canal no encontrado.", status: 404 }
  if (String(row.slug) === "equipo") {
    return { success: false, error: "Equipo no se puede eliminar.", status: 409 }
  }

  const { error: delErr } = await supabase
    .from("pop_chat_channels")
    .delete()
    .eq("id", channelId)
    .eq("pop_id", popId)
  if (delErr) {
    return { success: false, error: channelWriteError(delErr.message), status: 500 }
  }
  return { success: true }
}

export async function sendChatMessage(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  channelId: string,
  body: string,
): Promise<
  | { success: true; data: ChatMessageRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: channel } = await supabase
    .from("pop_chat_channels")
    .select("id")
    .eq("pop_id", popId)
    .eq("id", channelId)
    .maybeSingle()
  if (!channel) return { success: false, error: "Canal no encontrado.", status: 404 }

  const authorName = await authorNameOf(supabase, popId, userId)
  const { data, error } = await supabase
    .from("pop_chat_messages")
    .insert({
      pop_id: popId,
      channel_id: channelId,
      author_user_id: userId,
      author_name: authorName,
      body,
    })
    .select("id, author_user_id, author_name, body, created_at")
    .single()

  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo enviar el mensaje.",
      status: 500,
    }
  }

  await supabase.from("pop_chat_channel_reads").upsert({
    channel_id: channelId,
    pop_id: popId,
    user_id: userId,
    last_read_at: new Date().toISOString(),
  })

  const imageMap = await loadUserImageUrls(supabase, [userId])
  return {
    success: true,
    data: {
      id: String(data.id),
      authorUserId: String(data.author_user_id),
      authorName: String(data.author_name),
      authorImageUrl: imageUrlOf(imageMap, userId),
      body: String(data.body),
      createdAt: String(data.created_at),
      mine: true,
    },
  }
}

export async function markChatChannelRead(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  channelId: string,
): Promise<{ success: true } | { success: false; error: string; status: 404 | 500 }> {
  const { data: channel } = await supabase
    .from("pop_chat_channels")
    .select("id")
    .eq("pop_id", popId)
    .eq("id", channelId)
    .maybeSingle()
  if (!channel) return { success: false, error: "Canal no encontrado.", status: 404 }

  const { error } = await supabase.from("pop_chat_channel_reads").upsert({
    channel_id: channelId,
    pop_id: popId,
    user_id: userId,
    last_read_at: new Date().toISOString(),
  })
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}
