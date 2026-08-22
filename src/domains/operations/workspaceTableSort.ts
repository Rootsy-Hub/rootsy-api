export type WorkspaceTableSortDirection = "asc" | "desc"

export type WorkspaceTableSortState = {
  sort: string | null
  ord: WorkspaceTableSortDirection
}

export type WorkspaceTableSortConfig<T extends string = string> = {
  allowed: Record<T, string>
  defaultColumn: T
  defaultAscending: boolean
}

export function resolveWorkspaceTableListOrder<T extends string>(
  state: WorkspaceTableSortState,
  config: WorkspaceTableSortConfig<T>,
): { column: string; ascending: boolean } {
  const key =
    state.sort && state.sort in config.allowed
      ? (state.sort as T)
      : config.defaultColumn
  const ascending =
    state.sort && state.sort in config.allowed
      ? state.ord === "asc"
      : config.defaultAscending
  return { column: config.allowed[key], ascending }
}
