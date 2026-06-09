import { Context, Effect, Layer } from "effect"
import { CacheService } from "./cache.js"
import { CountryService } from "./country.js"
import { fetchJson } from "./http.js"
import { isRecord } from "./json.js"
import { type ReportSource, type TravelReport } from "./report.js"

type Holiday = {
  readonly date: string
  readonly localName: string
  readonly name: string
  readonly global: boolean
}

type HolidayData = {
  readonly country: string
  readonly countryCode: string
  readonly year: number
  readonly holidays: ReadonlyArray<Holiday>
}

class HolidayError {
  readonly _tag = "HolidayError"

  constructor(readonly message: string) {}
}

export class HolidayService extends Context.Tag("HolidayService")<
  HolidayService,
  {
    readonly list: (countryCode: string, country: string, year: number) => Effect.Effect<HolidayData, HolidayError>
  }
>() {}

const holidayCacheTtlMs = 24 * 60 * 60 * 1000

const fetchHolidayJson = (url: string): Effect.Effect<unknown, HolidayError> =>
  fetchJson(url, {
    service: "Holiday service",
    makeError: (message) => new HolidayError(message)
  })

const holidayFromJson = (value: unknown): Holiday | undefined => {
  if (
    !isRecord(value) ||
    typeof value.date !== "string" ||
    typeof value.localName !== "string" ||
    typeof value.name !== "string" ||
    typeof value.global !== "boolean"
  ) {
    return undefined
  }

  return {
    date: value.date,
    localName: value.localName,
    name: value.name,
    global: value.global
  }
}

const listHolidays = (countryCode: string, country: string, year: number): Effect.Effect<HolidayData, HolidayError> =>
  fetchHolidayJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(countryCode)}`).pipe(
    Effect.flatMap((json) => {
      if (!Array.isArray(json)) {
        return Effect.fail(new HolidayError("Holiday response was not valid."))
      }

      const parsed = json.map(holidayFromJson).filter((holiday): holiday is Holiday => holiday !== undefined)

      if (parsed.length !== json.length) {
        return Effect.fail(new HolidayError("Holiday response contained invalid entries."))
      }

      const holidays = parsed.filter((holiday) => holiday.global)

      return Effect.succeed({
        country,
        countryCode,
        year,
        holidays
      })
    })
  )

export const HolidayServiceLive = Layer.succeed(HolidayService, {
  list: listHolidays
})

const cacheKeyForHolidays = (country: string, year: number) =>
  `holidays:v2:${country.trim().toLowerCase()}:${year}`

const formatHolidayDate = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    weekday: "short"
  }).format(new Date(`${date}T12:00:00`))

const visibleHolidays = (data: HolidayData): ReadonlyArray<Holiday> => {
  const currentYear = new Date().getFullYear()

  if (data.year !== currentYear) {
    return data.holidays
  }

  const today = new Date().toISOString().slice(0, 10)
  return data.holidays.filter((holiday) => holiday.date >= today)
}

const holidayReport = (data: HolidayData, source: ReportSource): TravelReport => {
  const holidays = visibleHolidays(data)
  const label = data.year === new Date().getFullYear() ? "Upcoming" : "Public Holidays"

  return {
    title: `Public holidays in ${data.country}`,
    summary: `${data.year} · ${data.holidays.length} public holidays`,
    source,
    sections: [
      {
        label,
        lines: holidays.length === 0
          ? ["No remaining public holidays this year."]
          : holidays.map((holiday) => {
            const translatedName = holiday.localName === holiday.name ? "" : ` (${holiday.localName})`
            return `${formatHolidayDate(holiday.date)} · ${holiday.name}${translatedName}`
          })
      },
      {
        label: "Travel Notes",
        lines: [
          "Public holidays may affect banks, government offices, transit, and store hours.",
          "Source: Nager.Date",
          `Cache: ${source}`
        ]
      }
    ]
  }
}

const holidayErrorReport = (country: string, year: number, message: string): TravelReport => ({
  title: `Public holidays in ${country}`,
  summary: `Could not load holidays for ${year}.`,
  source: "fallback",
  sections: [
    {
      label: "Error",
      lines: [message]
    },
    {
      label: "Try",
      lines: ["travel holidays argentina", "travel holidays japan 2027"]
    }
  ]
})

export const runHolidays = (country: string, year: number): Effect.Effect<TravelReport, never, CacheService | CountryService | HolidayService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const countries = yield* CountryService
    const holidays = yield* HolidayService
    const cacheKey = cacheKeyForHolidays(country, year)
    const cached = yield* cache.get<HolidayData>(cacheKey)

    if (cached !== undefined) {
      return holidayReport(cached, "cache")
    }

    const result = yield* countries.find(country).pipe(
      Effect.flatMap((countryData) => holidays.list(countryData.code, countryData.name, year)),
      Effect.map((data) => ({ _tag: "Success" as const, data })),
      Effect.catchAll((error) => Effect.succeed({ _tag: "Failure" as const, error }))
    )

    if (result._tag === "Failure") {
      return holidayErrorReport(country, year, result.error.message)
    }

    yield* cache.set(cacheKey, result.data, holidayCacheTtlMs)

    return holidayReport(result.data, "live")
  })
