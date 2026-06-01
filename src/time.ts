import { Context, Effect, Layer } from "effect"
import { CacheService } from "./cache.js"
import { fetchJson } from "./http.js"
import { isRecord } from "./json.js"
import { type ReportSource, type TravelReport } from "./report.js"

type TimeData = {
  readonly place: string
  readonly country: string
  readonly timezone: string
  readonly datetime: string
  readonly utcOffset: string
  readonly abbreviation: string
}

class TimeError {
  readonly _tag = "TimeError"

  constructor(readonly message: string) {}
}

export class TimeService extends Context.Tag("TimeService")<
  TimeService,
  {
    readonly current: (place: string) => Effect.Effect<TimeData, TimeError>
  }
>() {}

const timeCacheTtlMs = 30 * 1000

const stringFrom = (value: unknown, field: string): Effect.Effect<string, TimeError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new TimeError(`Time response is missing ${field}.`))

const fetchTimeJson = (url: string): Effect.Effect<unknown, TimeError> =>
  fetchJson(url, {
    service: "Time service",
    makeError: (message) => new TimeError(message)
  })

const findPlace = (place: string) =>
  fetchTimeJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`).pipe(
    Effect.flatMap((json) => {
      if (!isRecord(json) || !Array.isArray(json.results) || json.results.length === 0) {
        return Effect.fail(new TimeError(`Could not find timezone location for "${place}".`))
      }

      const firstResult = json.results[0]

      if (!isRecord(firstResult)) {
        return Effect.fail(new TimeError("Timezone location response was not valid."))
      }

      return Effect.all({
        name: stringFrom(firstResult.name, "location name"),
        country: stringFrom(firstResult.country, "country"),
        timezone: stringFrom(firstResult.timezone, "timezone")
      })
    })
  )

const getCurrentTime = (location: {
  readonly name: string
  readonly country: string
  readonly timezone: string
}): Effect.Effect<TimeData, TimeError> =>
  fetchTimeJson(`https://worldtimeapi.org/api/timezone/${location.timezone.split("/").map(encodeURIComponent).join("/")}`).pipe(
    Effect.flatMap((json) => {
      if (!isRecord(json)) {
        return Effect.fail(new TimeError("Current time response was not valid."))
      }

      return Effect.all({
        datetime: stringFrom(json.datetime, "datetime"),
        utcOffset: stringFrom(json.utc_offset, "UTC offset"),
        abbreviation: stringFrom(json.abbreviation, "timezone abbreviation")
      }).pipe(
        Effect.map((time) => ({
          place: location.name,
          country: location.country,
          timezone: location.timezone,
          datetime: time.datetime,
          utcOffset: time.utcOffset,
          abbreviation: time.abbreviation
        }))
      )
    }),
    Effect.catchAll(() => Effect.succeed(computedTime(location)))
  )

const computedTime = (location: {
  readonly name: string
  readonly country: string
  readonly timezone: string
}): TimeData => ({
  place: location.name,
  country: location.country,
  timezone: location.timezone,
  datetime: new Date().toISOString(),
  utcOffset: timezoneOffset(location.timezone),
  abbreviation: "Computed from timezone"
})

const timezoneOffset = (timezone: string): string => {
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset"
  }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")

  return offsetPart?.value ?? "Unknown"
}

export const TimeServiceLive = Layer.succeed(TimeService, {
  current: (place: string) =>
    findPlace(place).pipe(
      Effect.flatMap(getCurrentTime)
    )
})

const cacheKeyForTime = (place: string) => `time:${place.trim().toLowerCase()}`

const timeFallback = (place: string, reason: string): TimeData => ({
  place,
  country: "Unknown",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  datetime: new Date().toISOString(),
  utcOffset: "local",
  abbreviation: `Fallback because ${reason}`
})

const formatLocalDateTime = (datetime: string, timezone: string): string => {
  const date = new Date(datetime)

  if (Number.isNaN(date.getTime())) {
    return datetime
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone
  }).format(date)
}

const timeReport = (time: TimeData, source: ReportSource): TravelReport => ({
  title: `Local time in ${time.place}, ${time.country}`,
  summary: formatLocalDateTime(time.datetime, time.timezone),
  source,
  sections: [
    {
      label: "Time",
      lines: [
        `Local: ${formatLocalDateTime(time.datetime, time.timezone)}`,
        `Timezone: ${time.timezone}`,
        `UTC offset: ${time.utcOffset}`,
        `Abbreviation: ${time.abbreviation}`
      ]
    },
    {
      label: "Meta",
      lines: [`Source: ${source}`]
    }
  ]
})

export const runTime = (place: string): Effect.Effect<TravelReport, never, CacheService | TimeService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const time = yield* TimeService
    const cacheKey = cacheKeyForTime(place)
    const cached = yield* cache.get<TimeData>(cacheKey)

    if (cached !== undefined) {
      return timeReport(cached, "cache")
    }

    const fresh = yield* time.current(place).pipe(
      Effect.catchAll((error) => Effect.succeed(timeFallback(place, error.message)))
    )

    if (!fresh.abbreviation.startsWith("Fallback because")) {
      yield* cache.set(cacheKey, fresh, timeCacheTtlMs)
      return timeReport(fresh, "live")
    }

    return timeReport(fresh, "fallback")
  })
