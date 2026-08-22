export type MeProfile = {
  id: string
  firstName: string
  lastName: string
  fullName: string
  imageUrl: string | null
  canCreatePop: boolean
}

export type MePopSubscription = {
  isActive: boolean
  status: string
  planDisplayName: string
  daysRemaining: number | null
}

export type MePop = {
  id: string
  siteId: string
  name: string
  imageUrl: string | null
  backgroundImageUrl: string | null
  streetAddress: string | null
  isOwner: boolean
  roleName: string
  isActive: boolean
  canEnter: boolean
  permissions: string[]
  dockItemIds: string[]
  subscription: MePopSubscription
}
