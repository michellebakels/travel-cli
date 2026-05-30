#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import { Console, Context, Effect, Layer, Schedule } from "effect"

type TravelCommand =
  | { readonly _tag: "Weather"; readonly city: string }
  | { readonly _tag: "Flight"; readonly from: string; readonly to: string }
  | { readonly _tag: "Packing"; readonly destination: string }
  | { readonly _tag: "Currency"; readonly code: string }
  | { readonly _tag: "Help" }

type ReportSource = "live" | "cache" | "fallback"

type WeatherData = {
  readonly city: string
  readonly country: string
  readonly temperatureC: number
  readonly feelsLikeC: number
  readonly humidity: number
  readonly windKph: number
  readonly condition: string
  readonly observedAt: string
}

type TravelReport = {
  readonly title: string
  readonly summary: string
  readonly source: ReportSource
  readonly sections: ReadonlyArray<{
    readonly label: string
    readonly lines: ReadonlyArray<string>
  }>
}

type CacheFile = Record<string, {
  readonly expiresAt: number
  readonly value: unknown
}>

class CliError {
  readonly _tag = "CliError"

  constructor(readonly message: string) {}
}

class WeatherError {
  readonly _tag = "WeatherError"

  constructor(readonly message: string) {}
}

class CacheError {
  readonly _tag = "CacheError"

  constructor(readonly message: string) {}
}

class CacheService extends Context.Tag("CacheService")<
  CacheService,
  {
    readonly get: <A>(key: string) => Effect.Effect<A | undefined>
    readonly set: <A>(key: string, value: A, ttlMs: number) => Effect.Effect<void>
  }
>() {}

class WeatherService extends Context.Tag("WeatherService")<
  WeatherService,
  {
    readonly current: (city: string) => Effect.Effect<WeatherData, WeatherError>
  }
>() {}

const cacheFile = ".travel-cache.json"
const weatherCacheTtlMs = 30 * 60 * 1000

const usage = `travel command center

Usage:
  travel weather <city>
  travel flight <from> <to>
  travel packing <destination>
  travel currency <code>`

const parseCommand = (args: ReadonlyArray<string>): Effect.Effect<TravelCommand, CliError> => {
  const [command, firstArg, secondArg] = args

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return Effect.succeed({ _tag: "Help" })

    case "weather":
      return firstArg === undefined
        ? Effect.fail(new CliError("Missing city for weather command."))
        : Effect.succeed({ _tag: "Weather", city: firstArg })

    case "flight":
      return firstArg === undefined || secondArg === undefined
        ? Effect.fail(new CliError("Missing airport codes for flight command."))
        : Effect.succeed({ _tag: "Flight", from: firstArg, to: secondArg })

    case "packing":
      return firstArg === undefined
        ? Effect.fail(new CliError("Missing destination for packing command."))
        : Effect.succeed({ _tag: "Packing", destination: firstArg })

    case "currency":
      return firstArg === undefined
        ? Effect.fail(new CliError("Missing currency code for currency command."))
        : Effect.succeed({ _tag: "Currency", code: firstArg })

    default:
      return Effect.fail(new CliError(`Unknown command: ${command}`))
  }
}

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

const CacheServiceLive = Layer.succeed(CacheService, {
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

const fetchJson = (url: string): Effect.Effect<unknown, WeatherError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      return await response.json()
    },
    catch: (cause) => new WeatherError(`Weather service request failed: ${String(cause)}`)
  }).pipe(
    Effect.timeoutFail({
      duration: "8 seconds",
      onTimeout: () => new WeatherError("Weather service timed out.")
    }),
    Effect.retry(Schedule.recurs(1))
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const numberFrom = (value: unknown, field: string): Effect.Effect<number, WeatherError> =>
  typeof value === "number"
    ? Effect.succeed(value)
    : Effect.fail(new WeatherError(`Weather response is missing ${field}.`))

const stringFrom = (value: unknown, field: string): Effect.Effect<string, WeatherError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new WeatherError(`Weather response is missing ${field}.`))

const weatherCondition = (code: number): string => {
  if (code === 0) return "Clear sky"
  if ([1, 2, 3].includes(code)) return "Partly cloudy"
  if ([45, 48].includes(code)) return "Fog"
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle"
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain"
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow"
  if ([95, 96, 99].includes(code)) return "Thunderstorm"

  return "Unknown conditions"
}

const findCity = (city: string) =>
  fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`).pipe(
    Effect.flatMap((json) => {
      if (!isRecord(json) || !Array.isArray(json.results) || json.results.length === 0) {
        return Effect.fail(new WeatherError(`Could not find weather location for "${city}".`))
      }

      const firstResult = json.results[0]

      if (!isRecord(firstResult)) {
        return Effect.fail(new WeatherError("Weather location response was not valid."))
      }

      return Effect.all({
        name: stringFrom(firstResult.name, "location name"),
        country: stringFrom(firstResult.country, "country"),
        latitude: numberFrom(firstResult.latitude, "latitude"),
        longitude: numberFrom(firstResult.longitude, "longitude")
      })
    })
  )

const getForecast = (location: {
  readonly name: string
  readonly country: string
  readonly latitude: number
  readonly longitude: number
}): Effect.Effect<WeatherData, WeatherError> => {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
    timezone: "auto"
  })

  return fetchJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`).pipe(
    Effect.flatMap((json) => {
      if (!isRecord(json) || !isRecord(json.current)) {
        return Effect.fail(new WeatherError("Weather forecast response was not valid."))
      }

      return Effect.all({
        temperatureC: numberFrom(json.current.temperature_2m, "temperature"),
        feelsLikeC: numberFrom(json.current.apparent_temperature, "apparent temperature"),
        humidity: numberFrom(json.current.relative_humidity_2m, "humidity"),
        windKph: numberFrom(json.current.wind_speed_10m, "wind speed"),
        weatherCode: numberFrom(json.current.weather_code, "weather code"),
        observedAt: stringFrom(json.current.time, "observation time")
      }).pipe(
        Effect.map((current) => ({
          city: location.name,
          country: location.country,
          temperatureC: current.temperatureC,
          feelsLikeC: current.feelsLikeC,
          humidity: current.humidity,
          windKph: current.windKph,
          condition: weatherCondition(current.weatherCode),
          observedAt: current.observedAt
        }))
      )
    })
  )
}

const WeatherServiceLive = Layer.succeed(WeatherService, {
  current: (city: string) =>
    findCity(city).pipe(
      Effect.flatMap(getForecast)
    )
})

const cacheKeyForWeather = (city: string) => `weather:${city.trim().toLowerCase()}`

const weatherFallback = (city: string, reason: string): WeatherData => ({
  city,
  country: "Unknown",
  temperatureC: 22,
  feelsLikeC: 22,
  humidity: 50,
  windKph: 10,
  condition: `Fallback forecast because ${reason}`,
  observedAt: new Date().toISOString()
})

const weatherReport = (weather: WeatherData, source: ReportSource): TravelReport => ({
  title: `Weather for ${weather.city}, ${weather.country}`,
  summary: `${weather.condition}, ${Math.round(weather.temperatureC)}C`,
  source,
  sections: [
    {
      label: "Current",
      lines: [
        `Temperature: ${weather.temperatureC}C`,
        `Feels like: ${weather.feelsLikeC}C`,
        `Humidity: ${weather.humidity}%`,
        `Wind: ${weather.windKph} km/h`
      ]
    },
    {
      label: "Meta",
      lines: [
        `Observed at: ${weather.observedAt}`,
        `Source: ${source}`
      ]
    }
  ]
})

const renderReport = (report: TravelReport): string => {
  const sections = report.sections.flatMap((section) => [
    "",
    section.label,
    ...section.lines.map((line) => `  ${line}`)
  ])

  return [
    report.title,
    report.summary,
    ...sections
  ].join("\n")
}

const runWeather = (city: string): Effect.Effect<TravelReport, never, CacheService | WeatherService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const weather = yield* WeatherService
    const cacheKey = cacheKeyForWeather(city)
    const cached = yield* cache.get<WeatherData>(cacheKey)

    if (cached !== undefined) {
      return weatherReport(cached, "cache")
    }

    const fresh = yield* weather.current(city).pipe(
      Effect.catchAll((error) => Effect.succeed(weatherFallback(city, error.message)))
    )

    if (!fresh.condition.startsWith("Fallback forecast")) {
      yield* cache.set(cacheKey, fresh, weatherCacheTtlMs)
      return weatherReport(fresh, "live")
    }

    return weatherReport(fresh, "fallback")
  })

const notImplementedReport = (command: Exclude<TravelCommand, { readonly _tag: "Weather" } | { readonly _tag: "Help" }>): TravelReport => ({
  title: `${command._tag} is not implemented yet`,
  summary: "We are building this CLI one command at a time. Weather works first.",
  source: "fallback",
  sections: [
    {
      label: "Next",
      lines: ["Run: travel weather miami"]
    }
  ]
})

const runCommand = (command: TravelCommand): Effect.Effect<string, never, CacheService | WeatherService> => {
  switch (command._tag) {
    case "Help":
      return Effect.succeed(usage)
    case "Weather":
      return runWeather(command.city).pipe(Effect.map(renderReport))
    case "Flight":
    case "Packing":
    case "Currency":
      return Effect.succeed(renderReport(notImplementedReport(command)))
  }
}

const AppLayer = Layer.mergeAll(CacheServiceLive, WeatherServiceLive)

const program = parseCommand(process.argv.slice(2)).pipe(
  Effect.flatMap(runCommand),
  Effect.flatMap(Console.log),
  Effect.catchAll((error) =>
    Console.error(`${error.message}\n\n${usage}`).pipe(
      Effect.tap(() => Effect.sync(() => {
        process.exitCode = 1
      }))
    )
  ),
  Effect.provide(AppLayer)
)

Effect.runPromise(program)
