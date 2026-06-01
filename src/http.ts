import { Effect, Schedule } from "effect"

export const fetchJson = <E>(
  url: string,
  options: {
    readonly service: string
    readonly makeError: (message: string) => E
  }
): Effect.Effect<unknown, E> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      return await response.json()
    },
    catch: (cause) => options.makeError(`${options.service} request failed: ${String(cause)}`)
  }).pipe(
    Effect.timeoutFail({
      duration: "8 seconds",
      onTimeout: () => options.makeError(`${options.service} timed out.`)
    }),
    Effect.retry(Schedule.recurs(1))
  )
