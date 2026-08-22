export function fetchWithTimeout(ms: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms)
    const signal =
      init?.signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([init.signal, timeout])
        : timeout
    return fetch(input, { ...init, signal })
  }
}

export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === "TimeoutError" || err.name === "AbortError"
}
