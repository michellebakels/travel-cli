import { readFile, writeFile } from "node:fs/promises"
import { Context, Effect, Layer } from "effect"

type CacheFile = Record<string, {
  readonly expiresAt: number
  readonly value: unknown
}>

class CacheError {
  readonly _tag = "CacheError"

  constructor(readonly message: string) {}
}

export class CacheService extends Context.Tag("CacheService")<
  CacheService,
  {
    readonly get: <A>(key: string) => Effect.Effect<A | undefined>
    readonly set: <A>(key: string, value: A, ttlMs: number) => Effect.Effect<void>
  }
>() {}

const cacheFile = ".travel-cache.json"

const readCacheFile = Effect.tryPromise({
  try: () => readFile(cacheFile, "utf8"),
  catch: () => new CacheError("Could not read cache file.")
}).pipe(
  Effect.flatMap((contents) =>
    Effect.try({
      try: () => JSON.parse(contents) as CacheFile,
      catch: () => new CacheError("Could not parse cache file.")
    })
  ),
  Effect.catchAll(() => Effect.succeed({} as CacheFile))
)

export const CacheServiceLive = Layer.succeed(CacheService, {
  get: <A>(key: string) =>
    readCacheFile.pipe(
      Effect.map((cache) => {
        const entry = cache[key]

        if (entry === undefined || entry.expiresAt <= Date.now()) {
          return undefined
        }

        return entry.value as A
      })
    ),

  set: <A>(key: string, value: A, ttlMs: number) =>
    readCacheFile.pipe(
      Effect.map((cache) => ({
        ...cache,
        [key]: {
          expiresAt: Date.now() + ttlMs,
          value
        }
      } satisfies CacheFile)),
      Effect.flatMap((cache) =>
        Effect.tryPromise({
          try: () => writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8"),
          catch: () => new CacheError("Could not write cache file.")
        })
      ),
      Effect.catchAll(() => Effect.void)
    )
})
