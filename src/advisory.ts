import { Context, Effect, Layer } from "effect"
import { CacheService } from "./cache.js"
import { CountryService } from "./country.js"
import { fetchJson } from "./http.js"
import { isRecord } from "./json.js"
import { formatObservedAt, type ReportSource, type TravelReport } from "./report.js"

type AdvisoryData = {
  readonly countryCode: string
  readonly countryName: string
  readonly level: number
  readonly levelLabel: string
  readonly summary: string
  readonly link: string
  readonly updatedAt: string
}

class AdvisoryError {
  readonly _tag = "AdvisoryError"

  constructor(readonly message: string) {}
}

export class AdvisoryService extends Context.Tag("AdvisoryService")<
  AdvisoryService,
  {
    readonly find: (countryCode: string, countryName: string) => Effect.Effect<AdvisoryData, AdvisoryError>
  }
>() {}

const advisoryCacheTtlMs = 6 * 60 * 60 * 1000

const fetchAdvisoryJson = (url: string): Effect.Effect<unknown, AdvisoryError> =>
  fetchJson(url, {
    service: "Advisory service",
    makeError: (message) => new AdvisoryError(message)
  })

const stringFrom = (value: unknown, field: string): Effect.Effect<string, AdvisoryError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new AdvisoryError(`Advisory response is missing ${field}.`))

const decodeHtml = (value: string): string =>
  value
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

const advisoryFromJson = (json: unknown): Effect.Effect<AdvisoryData, AdvisoryError> => {
  if (!Array.isArray(json) || json.length === 0 || !isRecord(json[0])) {
    return Effect.fail(new AdvisoryError("No travel advisory was found for that country."))
  }

  const advisory = json[0]

  return Effect.all({
    title: stringFrom(advisory.Title, "title"),
    summary: stringFrom(advisory.Summary, "summary"),
    link: stringFrom(advisory.Link, "link"),
    updatedAt: stringFrom(advisory.Updated, "updated time")
  }).pipe(
    Effect.flatMap(({ title, summary, link, updatedAt }) => {
      const titleMatch = title.match(/^(.+?) - Level (\d): (.+)$/)

      if (titleMatch === null) {
        return Effect.fail(new AdvisoryError("Advisory title was not valid."))
      }

      const [, countryName, level, levelLabel] = titleMatch

      if (countryName === undefined || level === undefined || levelLabel === undefined) {
        return Effect.fail(new AdvisoryError("Advisory title was incomplete."))
      }

      return Effect.succeed({
        countryCode: Array.isArray(advisory.Category) && typeof advisory.Category[0] === "string"
          ? advisory.Category[0]
          : "Unknown",
        countryName,
        level: Number(level),
        levelLabel,
        summary: decodeHtml(summary),
        link,
        updatedAt
      })
    })
  )
}

const findAdvisoryByName = (countryName: string): Effect.Effect<AdvisoryData, AdvisoryError> =>
  fetchAdvisoryJson("https://cadataapi.state.gov/api/TravelAdvisories").pipe(
    Effect.flatMap((json) => {
      if (!Array.isArray(json)) {
        return Effect.fail(new AdvisoryError("Travel advisory list was not valid."))
      }

      const advisory = json.find((entry) =>
        isRecord(entry) && typeof entry.Title === "string" && entry.Title.startsWith(`${countryName} - Level `)
      )

      return advisoryFromJson(advisory === undefined ? [] : [advisory])
    })
  )

const findAdvisory = (countryCode: string, countryName: string): Effect.Effect<AdvisoryData, AdvisoryError> =>
  fetchAdvisoryJson(`https://cadataapi.state.gov/api/TravelAdvisories/${encodeURIComponent(countryCode)}`).pipe(
    Effect.flatMap((json) => Array.isArray(json) && json.length > 0
      ? advisoryFromJson(json)
      : findAdvisoryByName(countryName)
    )
  )

export const AdvisoryServiceLive = Layer.succeed(AdvisoryService, {
  find: findAdvisory
})

const cacheKeyForAdvisory = (country: string) => `advisory:${country.trim().toLowerCase()}`

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength).trim()}...`

const advisoryReport = (advisory: AdvisoryData, source: ReportSource, full: boolean): TravelReport => ({
  title: `Travel advisory for ${advisory.countryName}`,
  summary: `Level ${advisory.level}: ${advisory.levelLabel}`,
  source,
  sections: [
    {
      label: "Warning",
      lines: [full ? advisory.summary : truncate(advisory.summary, 700)]
    },
    {
      label: "Details",
      lines: [
        `Country code: ${advisory.countryCode}`,
        `Updated: ${formatObservedAt(advisory.updatedAt)}`,
        `Full advisory: ${advisory.link}`,
        "Source: U.S. Department of State",
        "Always review the official advisory before making travel decisions.",
        `Cache: ${source}`
      ]
    }
  ]
})

const advisoryErrorReport = (country: string, message: string): TravelReport => ({
  title: `Travel advisory for ${country}`,
  summary: "Could not load travel advisory.",
  source: "fallback",
  sections: [
    {
      label: "Error",
      lines: [message]
    },
    {
      label: "Try",
      lines: ["travel advisory argentina", "travel advisory japan"]
    }
  ]
})

export const runAdvisory = (country: string, full = false): Effect.Effect<TravelReport, never, CacheService | CountryService | AdvisoryService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const countries = yield* CountryService
    const advisories = yield* AdvisoryService
    const cacheKey = cacheKeyForAdvisory(country)
    const cached = yield* cache.get<AdvisoryData>(cacheKey)

    if (cached !== undefined) {
      return advisoryReport(cached, "cache", full)
    }

    const result = yield* countries.find(country).pipe(
      Effect.flatMap((countryData) => advisories.find(countryData.code, countryData.name)),
      Effect.map((data) => ({ _tag: "Success" as const, data })),
      Effect.catchAll((error) => Effect.succeed({ _tag: "Failure" as const, error }))
    )

    if (result._tag === "Failure") {
      return advisoryErrorReport(country, result.error.message)
    }

    yield* cache.set(cacheKey, result.data, advisoryCacheTtlMs)

    return advisoryReport(result.data, "live", full)
  })
