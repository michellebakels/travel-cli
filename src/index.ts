#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import { Console, Context, Effect, Layer, Schedule } from "effect"

type TravelCommand =
  | { readonly _tag: "Weather"; readonly city: string }
  | { readonly _tag: "Packing"; readonly destination: string }
  | { readonly _tag: "Currency"; readonly conversion: CurrencyConversion }
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

type CurrencyData = {
  readonly baseCode: "USD"
  readonly targetCode: string
  readonly rate: number
  readonly updatedAt: string
}

type CurrencyConversion = {
  readonly amount: number
  readonly fromCode: string
  readonly toCode: string
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

type CacheFile = Record<
  string,
  {
    readonly expiresAt: number
    readonly value: unknown
  }
>

class CliError {
  readonly _tag = "CliError"

  constructor(readonly message: string) {}
}

class WeatherError {
  readonly _tag = "WeatherError"

  constructor(readonly message: string) {}
}

class CurrencyError {
  readonly _tag = "CurrencyError"

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
    readonly set: <A>(
      key: string,
      value: A,
      ttlMs: number,
    ) => Effect.Effect<void>
  }
>() {}

class WeatherService extends Context.Tag("WeatherService")<
  WeatherService,
  {
    readonly current: (city: string) => Effect.Effect<WeatherData, WeatherError>
  }
>() {}

class CurrencyService extends Context.Tag("CurrencyService")<
  CurrencyService,
  {
    readonly exchangeRate: (
      code: string,
    ) => Effect.Effect<CurrencyData, CurrencyError>
  }
>() {}

const cacheFile = ".travel-cache.json"
const weatherCacheTtlMs = 30 * 60 * 1000
const currencyCacheTtlMs = 6 * 60 * 60 * 1000

const usage = `travel command center

Usage:
  travel weather <city>
  travel packing <destination>
  travel currency <code>
  travel currency <amount> <code>
  travel currency <amount> <from> <to>`

const parseCurrencyAmount = (value: string): number | undefined => {
  const amount = Number(value)

  return Number.isFinite(amount) && amount > 0 ? amount : undefined
}

const parseCurrencyCommand = (
  args: ReadonlyArray<string>,
): Effect.Effect<TravelCommand, CliError> => {
  const [firstArg, secondArg, thirdArg, extraArg] = args

  if (firstArg === undefined) {
    return Effect.fail(
      new CliError("Missing currency code for currency command."),
    )
  }

  if (extraArg !== undefined) {
    return Effect.fail(new CliError("Too many arguments for currency command."))
  }

  const amount = parseCurrencyAmount(firstArg)

  if (amount === undefined) {
    return secondArg === undefined
      ? Effect.succeed({
          _tag: "Currency",
          conversion: { amount: 1, fromCode: "USD", toCode: firstArg },
        })
      : Effect.succeed({
          _tag: "Currency",
          conversion: { amount: 1, fromCode: firstArg, toCode: secondArg },
        })
  }

  if (secondArg === undefined) {
    return Effect.fail(new CliError("Missing currency code after amount."))
  }

  return Effect.succeed({
    _tag: "Currency",
    conversion: {
      amount,
      fromCode: secondArg,
      toCode: thirdArg ?? "USD",
    },
  })
}

const parseCommand = (
  args: ReadonlyArray<string>,
): Effect.Effect<TravelCommand, CliError> => {
  const [command, firstArg] = args

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

    case "packing":
      return firstArg === undefined
        ? Effect.fail(new CliError("Missing destination for packing command."))
        : Effect.succeed({ _tag: "Packing", destination: firstArg })

    case "currency":
      return parseCurrencyCommand(args.slice(1))

    default:
      return Effect.fail(new CliError(`Unknown command: ${command}`))
  }
}

const readCacheFile = Effect.tryPromise({
  try: () => readFile(cacheFile, "utf8"),
  catch: () => new CacheError("Could not read cache file."),
}).pipe(
  Effect.flatMap((contents) =>
    Effect.try({
      try: () => JSON.parse(contents) as CacheFile,
      catch: () => new CacheError("Could not parse cache file."),
    }),
  ),
  Effect.catchAll(() => Effect.succeed({} as CacheFile)),
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
      }),
    ),

  set: <A>(key: string, value: A, ttlMs: number) =>
    readCacheFile.pipe(
      Effect.map(
        (cache) =>
          ({
            ...cache,
            [key]: {
              expiresAt: Date.now() + ttlMs,
              value,
            },
          }) satisfies CacheFile,
      ),
      Effect.flatMap((cache) =>
        Effect.tryPromise({
          try: () =>
            writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8"),
          catch: () => new CacheError("Could not write cache file."),
        }),
      ),
      Effect.catchAll(() => Effect.void),
    ),
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
    catch: (cause) =>
      new WeatherError(`Weather service request failed: ${String(cause)}`),
  }).pipe(
    Effect.timeoutFail({
      duration: "8 seconds",
      onTimeout: () => new WeatherError("Weather service timed out."),
    }),
    Effect.retry(Schedule.recurs(1)),
  )

const fetchCurrencyJson = (
  url: string,
): Effect.Effect<unknown, CurrencyError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      return await response.json()
    },
    catch: (cause) =>
      new CurrencyError(`Currency service request failed: ${String(cause)}`),
  }).pipe(
    Effect.timeoutFail({
      duration: "8 seconds",
      onTimeout: () => new CurrencyError("Currency service timed out."),
    }),
    Effect.retry(Schedule.recurs(1)),
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const numberFrom = (
  value: unknown,
  field: string,
): Effect.Effect<number, WeatherError> =>
  typeof value === "number"
    ? Effect.succeed(value)
    : Effect.fail(new WeatherError(`Weather response is missing ${field}.`))

const stringFrom = (
  value: unknown,
  field: string,
): Effect.Effect<string, WeatherError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new WeatherError(`Weather response is missing ${field}.`))

const currencyStringFrom = (
  value: unknown,
  field: string,
): Effect.Effect<string, CurrencyError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new CurrencyError(`Currency response is missing ${field}.`))

const normalizeCurrencyCode = (code: string): string =>
  code.trim().toUpperCase()

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
  fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
  ).pipe(
    Effect.flatMap((json) => {
      if (
        !isRecord(json) ||
        !Array.isArray(json.results) ||
        json.results.length === 0
      ) {
        return Effect.fail(
          new WeatherError(`Could not find weather location for "${city}".`),
        )
      }

      const firstResult = json.results[0]

      if (!isRecord(firstResult)) {
        return Effect.fail(
          new WeatherError("Weather location response was not valid."),
        )
      }

      return Effect.all({
        name: stringFrom(firstResult.name, "location name"),
        country: stringFrom(firstResult.country, "country"),
        latitude: numberFrom(firstResult.latitude, "latitude"),
        longitude: numberFrom(firstResult.longitude, "longitude"),
      })
    }),
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
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
    timezone: "auto",
  })

  return fetchJson(
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
  ).pipe(
    Effect.flatMap((json) => {
      if (!isRecord(json) || !isRecord(json.current)) {
        return Effect.fail(
          new WeatherError("Weather forecast response was not valid."),
        )
      }

      return Effect.all({
        temperatureC: numberFrom(json.current.temperature_2m, "temperature"),
        feelsLikeC: numberFrom(
          json.current.apparent_temperature,
          "apparent temperature",
        ),
        humidity: numberFrom(json.current.relative_humidity_2m, "humidity"),
        windKph: numberFrom(json.current.wind_speed_10m, "wind speed"),
        weatherCode: numberFrom(json.current.weather_code, "weather code"),
        observedAt: stringFrom(json.current.time, "observation time"),
      }).pipe(
        Effect.map((current) => ({
          city: location.name,
          country: location.country,
          temperatureC: current.temperatureC,
          feelsLikeC: current.feelsLikeC,
          humidity: current.humidity,
          windKph: current.windKph,
          condition: weatherCondition(current.weatherCode),
          observedAt: current.observedAt,
        })),
      )
    }),
  )
}

const WeatherServiceLive = Layer.succeed(WeatherService, {
  current: (city: string) => findCity(city).pipe(Effect.flatMap(getForecast)),
})

const getExchangeRate = (
  code: string,
): Effect.Effect<CurrencyData, CurrencyError> => {
  const targetCode = normalizeCurrencyCode(code)

  if (!/^[A-Z]{3}$/.test(targetCode)) {
    return Effect.fail(
      new CurrencyError(
        "Currency code must be three letters, like ARS or EUR.",
      ),
    )
  }

  return fetchCurrencyJson("https://open.er-api.com/v6/latest/USD").pipe(
    Effect.flatMap((json) => {
      if (!isRecord(json) || !isRecord(json.rates)) {
        return Effect.fail(
          new CurrencyError("Currency response was not valid."),
        )
      }

      const rate = json.rates[targetCode]

      if (typeof rate !== "number") {
        return Effect.fail(
          new CurrencyError(
            `Currency ${targetCode} is not supported by the exchange-rate API.`,
          ),
        )
      }

      return Effect.all({
        baseCode: currencyStringFrom(json.base_code, "base code"),
        updatedAt: currencyStringFrom(json.time_last_update_utc, "update time"),
      }).pipe(
        Effect.flatMap(({ baseCode, updatedAt }) => {
          if (baseCode !== "USD") {
            return Effect.fail(
              new CurrencyError(
                `Expected USD base currency but received ${baseCode}.`,
              ),
            )
          }

          return Effect.succeed({
            baseCode,
            targetCode,
            rate,
            updatedAt,
          })
        }),
      )
    }),
  )
}

const CurrencyServiceLive = Layer.succeed(CurrencyService, {
  exchangeRate: getExchangeRate,
})

const cacheKeyForWeather = (city: string) =>
  `weather:${city.trim().toLowerCase()}`
const cacheKeyForCurrency = (code: string) =>
  `currency:usd:${normalizeCurrencyCode(code).toLowerCase()}`

const currencyRateCodeForConversion = (
  conversion: CurrencyConversion,
): Effect.Effect<string, CurrencyError> => {
  const fromCode = normalizeCurrencyCode(conversion.fromCode)
  const toCode = normalizeCurrencyCode(conversion.toCode)

  if (!/^[A-Z]{3}$/.test(fromCode) || !/^[A-Z]{3}$/.test(toCode)) {
    return Effect.fail(
      new CurrencyError(
        "Currency codes must be three letters, like USD, ARS, or EUR.",
      ),
    )
  }

  if (fromCode === "USD") {
    return Effect.succeed(toCode)
  }

  if (toCode === "USD") {
    return Effect.succeed(fromCode)
  }

  return Effect.fail(
    new CurrencyError(
      "Currency conversions currently require USD on one side.",
    ),
  )
}

const weatherFallback = (city: string, reason: string): WeatherData => ({
  city,
  country: "Unknown",
  temperatureC: 22,
  feelsLikeC: 22,
  humidity: 50,
  windKph: 10,
  condition: `Fallback forecast because ${reason}`,
  observedAt: new Date().toISOString(),
})

const formatTemperature = (celsius: number): string => {
  const fahrenheit = (celsius * 9) / 5 + 32

  return `${Math.round(celsius)}C / ${Math.round(fahrenheit)}F`
}

const formatObservedAt = (observedAt: string): string => {
  const date = new Date(observedAt)

  if (Number.isNaN(date.getTime())) {
    return observedAt
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

const formatCurrencyAmount = (
  amount: number,
  code: string,
  maximumFractionDigits = 2,
): string => {
  const normalizedCode = normalizeCurrencyCode(code)

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCode,
      maximumFractionDigits,
    }).format(amount)
  } catch {
    return `${amount.toLocaleString("en-US", { maximumFractionDigits })} ${normalizedCode}`
  }
}

const convertedCurrencyAmount = (
  currency: CurrencyData,
  conversion: CurrencyConversion,
): number => {
  const fromCode = normalizeCurrencyCode(conversion.fromCode)
  const toCode = normalizeCurrencyCode(conversion.toCode)

  if (fromCode === "USD" && toCode === currency.targetCode) {
    return conversion.amount * currency.rate
  }

  if (fromCode === currency.targetCode && toCode === "USD") {
    return conversion.amount / currency.rate
  }

  return conversion.amount
}

const weatherReport = (
  weather: WeatherData,
  source: ReportSource,
): TravelReport => ({
  title: `Weather for ${weather.city}, ${weather.country}`,
  summary: `${weather.condition}, ${formatTemperature(weather.temperatureC)}`,
  source,
  sections: [
    {
      label: "Current",
      lines: [
        `Temperature: ${formatTemperature(weather.temperatureC)}`,
        `Feels like: ${formatTemperature(weather.feelsLikeC)}`,
        `Humidity: ${weather.humidity}%`,
        `Wind: ${weather.windKph} km/h`,
      ],
    },
    {
      label: "Meta",
      lines: [
        `Observed at: ${formatObservedAt(weather.observedAt)}`,
        `Source: ${source}`,
      ],
    },
  ],
})

const currencyReport = (
  currency: CurrencyData,
  conversion: CurrencyConversion,
  source: ReportSource,
): TravelReport => ({
  title: `${normalizeCurrencyCode(conversion.fromCode)} → ${normalizeCurrencyCode(conversion.toCode)}`,
  summary: `${formatCurrencyAmount(conversion.amount, conversion.fromCode)} = ${formatCurrencyAmount(convertedCurrencyAmount(currency, conversion), conversion.toCode)}`,
  source,
  sections: [
    {
      label: "Conversion",
      lines: [
        `${formatCurrencyAmount(conversion.amount, conversion.fromCode)} = ${formatCurrencyAmount(convertedCurrencyAmount(currency, conversion), conversion.toCode)}`,
      ],
    },
    {
      label: "Exchange Rate",
      lines: [
        `1 ${currency.baseCode} = ${formatCurrencyAmount(currency.rate, currency.targetCode)}`,
        `1 ${currency.targetCode} = ${formatCurrencyAmount(1 / currency.rate, currency.baseCode, 6)}`,
      ],
    },
    {
      label: "Meta",
      lines: [
        `Updated: ${formatObservedAt(currency.updatedAt)}`,
        `Source: ${source}`,
      ],
    },
  ],
})

const currencyErrorReport = (
  conversion: CurrencyConversion,
  message: string,
): TravelReport => ({
  title: `${normalizeCurrencyCode(conversion.fromCode)} → ${normalizeCurrencyCode(conversion.toCode)}`,
  summary: "Could not load exchange rate.",
  source: "fallback",
  sections: [
    {
      label: "Error",
      lines: [message],
    },
    {
      label: "Try",
      lines: [
        "travel currency ars",
        "travel currency 100 ars",
        "travel currency 100 usd ars",
        "travel currency 100 ars usd",
      ],
    },
  ],
})

const renderReport = (report: TravelReport): string => {
  const sections = report.sections.flatMap((section) => [
    "",
    section.label,
    ...section.lines.map((line) => `  ${line}`),
  ])

  return [report.title, report.summary, ...sections].join("\n")
}

const runWeather = (
  city: string,
): Effect.Effect<TravelReport, never, CacheService | WeatherService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const weather = yield* WeatherService
    const cacheKey = cacheKeyForWeather(city)
    const cached = yield* cache.get<WeatherData>(cacheKey)

    if (cached !== undefined) {
      return weatherReport(cached, "cache")
    }

    const fresh = yield* weather
      .current(city)
      .pipe(
        Effect.catchAll((error) =>
          Effect.succeed(weatherFallback(city, error.message)),
        ),
      )

    if (!fresh.condition.startsWith("Fallback forecast")) {
      yield* cache.set(cacheKey, fresh, weatherCacheTtlMs)
      return weatherReport(fresh, "live")
    }

    return weatherReport(fresh, "fallback")
  })

const runCurrency = (
  conversion: CurrencyConversion,
): Effect.Effect<TravelReport, never, CacheService | CurrencyService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const currency = yield* CurrencyService

    const rateCodeResult = yield* currencyRateCodeForConversion(
      conversion,
    ).pipe(
      Effect.map((rateCode) => ({ _tag: "Success" as const, rateCode })),
      Effect.catchAll((error) =>
        Effect.succeed({ _tag: "Failure" as const, error }),
      ),
    )

    if (rateCodeResult._tag === "Failure") {
      return currencyErrorReport(conversion, rateCodeResult.error.message)
    }

    const cacheKey = cacheKeyForCurrency(rateCodeResult.rateCode)
    const cached = yield* cache.get<CurrencyData>(cacheKey)

    if (cached !== undefined) {
      return currencyReport(cached, conversion, "cache")
    }

    const result = yield* currency.exchangeRate(rateCodeResult.rateCode).pipe(
      Effect.map((data) => ({ _tag: "Success" as const, data })),
      Effect.catchAll((error) =>
        Effect.succeed({ _tag: "Failure" as const, error }),
      ),
    )

    if (result._tag === "Failure") {
      return currencyErrorReport(conversion, result.error.message)
    }

    yield* cache.set(cacheKey, result.data, currencyCacheTtlMs)

    return currencyReport(result.data, conversion, "live")
  })

const notImplementedReport = (
  command: Exclude<
    TravelCommand,
    | { readonly _tag: "Weather" }
    | { readonly _tag: "Currency" }
    | { readonly _tag: "Help" }
  >,
): TravelReport => ({
  title: `${command._tag} is not implemented yet`,
  summary:
    "We are building this CLI one command at a time. Weather and currency work first.",
  source: "fallback",
  sections: [
    {
      label: "Next",
      lines: ["Run: travel weather miami", "Run: travel currency ars"],
    },
  ],
})

const runCommand = (
  command: TravelCommand,
): Effect.Effect<
  string,
  never,
  CacheService | WeatherService | CurrencyService
> => {
  switch (command._tag) {
    case "Help":
      return Effect.succeed(usage)
    case "Weather":
      return runWeather(command.city).pipe(Effect.map(renderReport))
    case "Currency":
      return runCurrency(command.conversion).pipe(Effect.map(renderReport))
    case "Packing":
      return Effect.succeed(renderReport(notImplementedReport(command)))
  }
}

const AppLayer = Layer.mergeAll(
  CacheServiceLive,
  WeatherServiceLive,
  CurrencyServiceLive,
)

const program = parseCommand(process.argv.slice(2)).pipe(
  Effect.flatMap(runCommand),
  Effect.flatMap(Console.log),
  Effect.catchAll((error) =>
    Console.error(`${error.message}\n\n${usage}`).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
  Effect.provide(AppLayer),
)

Effect.runPromise(program)
