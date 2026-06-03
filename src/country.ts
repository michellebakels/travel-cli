import { Context, Effect, Layer } from "effect"
import { CacheService } from "./cache.js"
import { fetchJson } from "./http.js"
import { isRecord } from "./json.js"
import { type ReportSource, type TravelReport } from "./report.js"

export type CountryData = {
  readonly code: string
  readonly name: string
  readonly officialName: string
  readonly capital: string
  readonly region: string
  readonly subregion: string
  readonly population: number
  readonly languages: ReadonlyArray<string>
  readonly currencies: ReadonlyArray<string>
  readonly timezones: ReadonlyArray<string>
  readonly drivingSide: string
  readonly flag: string
}

class CountryError {
  readonly _tag = "CountryError"

  constructor(readonly message: string) {}
}

export class CountryService extends Context.Tag("CountryService")<
  CountryService,
  {
    readonly find: (country: string) => Effect.Effect<CountryData, CountryError>
  }
>() {}

const countryCacheTtlMs = 24 * 60 * 60 * 1000

const fetchCountryJson = (url: string): Effect.Effect<unknown, CountryError> =>
  fetchJson(url, {
    service: "Country service",
    makeError: (message) => new CountryError(message)
  })

const stringFrom = (value: unknown, field: string): Effect.Effect<string, CountryError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new CountryError(`Country response is missing ${field}.`))

const numberFrom = (value: unknown, field: string): Effect.Effect<number, CountryError> =>
  typeof value === "number"
    ? Effect.succeed(value)
    : Effect.fail(new CountryError(`Country response is missing ${field}.`))

const countryFromJson = (json: unknown): Effect.Effect<CountryData, CountryError> => {
  if (!Array.isArray(json) || json.length === 0 || !isRecord(json[0])) {
    return Effect.fail(new CountryError("Country response was not valid."))
  }

  const country = json[0]

  if (!isRecord(country.name)) {
    return Effect.fail(new CountryError("Country response is missing name."))
  }

  const capital = Array.isArray(country.capital) && typeof country.capital[0] === "string"
    ? country.capital[0]
    : "None"
  const languages = isRecord(country.languages)
    ? Object.values(country.languages).filter((language): language is string => typeof language === "string")
    : []
  const currencies = isRecord(country.currencies)
    ? Object.entries(country.currencies).flatMap(([code, currency]) => {
      if (!isRecord(currency) || typeof currency.name !== "string") {
        return []
      }

      return [`${currency.name} (${code})`]
    })
    : []
  const timezones = Array.isArray(country.timezones)
    ? country.timezones.filter((timezone): timezone is string => typeof timezone === "string")
    : []
  const drivingSide = isRecord(country.car) && typeof country.car.side === "string"
    ? country.car.side
    : "Unknown"

  return Effect.all({
    code: stringFrom(country.cca2, "country code"),
    name: stringFrom(country.name.common, "common name"),
    officialName: stringFrom(country.name.official, "official name"),
    region: stringFrom(country.region, "region"),
    subregion: stringFrom(country.subregion, "subregion"),
    population: numberFrom(country.population, "population"),
    flag: stringFrom(country.flag, "flag")
  }).pipe(
    Effect.map((required) => ({
      ...required,
      capital,
      languages,
      currencies,
      timezones,
      drivingSide
    }))
  )
}

const findCountry = (country: string): Effect.Effect<CountryData, CountryError> => {
  const fields = "cca2,name,capital,region,subregion,population,languages,currencies,timezones,car,flag"

  return fetchCountryJson(`https://restcountries.com/v3.1/name/${encodeURIComponent(country)}?fields=${fields}`).pipe(
    Effect.flatMap(countryFromJson)
  )
}

export const CountryServiceLive = Layer.succeed(CountryService, {
  find: findCountry
})

const cacheKeyForCountry = (country: string) => `country:${country.trim().toLowerCase()}`

const countryReport = (country: CountryData, source: ReportSource): TravelReport => ({
  title: `${country.flag} ${country.name}`,
  summary: `Capital: ${country.capital}`,
  source,
  sections: [
    {
      label: "Basics",
      lines: [
        `Official name: ${country.officialName}`,
        `Region: ${country.region}`,
        `Subregion: ${country.subregion}`,
        `Population: ${country.population.toLocaleString("en-US")}`,
        `Languages: ${country.languages.join(", ") || "Unknown"}`,
        `Currencies: ${country.currencies.join(", ") || "Unknown"}`
      ]
    },
    {
      label: "Travel Info",
      lines: [
        `Timezones: ${country.timezones.join(", ") || "Unknown"}`,
        `Driving side: ${country.drivingSide}`,
        `Source: ${source}`
      ]
    }
  ]
})

const countryErrorReport = (country: string, message: string): TravelReport => ({
  title: `Country: ${country}`,
  summary: "Could not load country information.",
  source: "fallback",
  sections: [
    {
      label: "Error",
      lines: [message]
    },
    {
      label: "Try",
      lines: ["travel country argentina", "travel country japan"]
    }
  ]
})

export const runCountry = (country: string): Effect.Effect<TravelReport, never, CacheService | CountryService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const countries = yield* CountryService
    const cacheKey = cacheKeyForCountry(country)
    const cached = yield* cache.get<CountryData>(cacheKey)

    if (cached !== undefined) {
      return countryReport(cached, "cache")
    }

    const result = yield* countries.find(country).pipe(
      Effect.map((data) => ({ _tag: "Success" as const, data })),
      Effect.catchAll((error) => Effect.succeed({ _tag: "Failure" as const, error }))
    )

    if (result._tag === "Failure") {
      return countryErrorReport(country, result.error.message)
    }

    yield* cache.set(cacheKey, result.data, countryCacheTtlMs)

    return countryReport(result.data, "live")
  })
