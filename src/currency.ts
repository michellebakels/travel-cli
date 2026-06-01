import { Context, Effect, Layer } from "effect"
import { CacheService } from "./cache.js"
import { fetchJson } from "./http.js"
import { isRecord } from "./json.js"
import { formatObservedAt, type ReportSource, type TravelReport } from "./report.js"

type CurrencyData = {
  readonly baseCode: "USD"
  readonly targetCode: string
  readonly rate: number
  readonly updatedAt: string
}

export type CurrencyConversion = {
  readonly amount: number
  readonly fromCode: string
  readonly toCode: string
}

class CurrencyError {
  readonly _tag = "CurrencyError"

  constructor(readonly message: string) {}
}

export class CurrencyService extends Context.Tag("CurrencyService")<
  CurrencyService,
  {
    readonly exchangeRate: (code: string) => Effect.Effect<CurrencyData, CurrencyError>
  }
>() {}

const currencyCacheTtlMs = 6 * 60 * 60 * 1000

export const normalizeCurrencyCode = (code: string): string => code.trim().toUpperCase()

const fetchCurrencyJson = (url: string): Effect.Effect<unknown, CurrencyError> =>
  fetchJson(url, {
    service: "Currency service",
    makeError: (message) => new CurrencyError(message)
  })

const currencyStringFrom = (value: unknown, field: string): Effect.Effect<string, CurrencyError> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new CurrencyError(`Currency response is missing ${field}.`))

const getExchangeRate = (code: string): Effect.Effect<CurrencyData, CurrencyError> => {
  const targetCode = normalizeCurrencyCode(code)

  if (!/^[A-Z]{3}$/.test(targetCode)) {
    return Effect.fail(new CurrencyError("Currency code must be three letters, like ARS or EUR."))
  }

  return fetchCurrencyJson("https://open.er-api.com/v6/latest/USD").pipe(
    Effect.flatMap((json) => {
      if (!isRecord(json) || !isRecord(json.rates)) {
        return Effect.fail(new CurrencyError("Currency response was not valid."))
      }

      const rate = json.rates[targetCode]

      if (typeof rate !== "number") {
        return Effect.fail(new CurrencyError(`Currency ${targetCode} is not supported by the exchange-rate API.`))
      }

      return Effect.all({
        baseCode: currencyStringFrom(json.base_code, "base code"),
        updatedAt: currencyStringFrom(json.time_last_update_utc, "update time")
      }).pipe(
        Effect.flatMap(({ baseCode, updatedAt }) => {
          if (baseCode !== "USD") {
            return Effect.fail(new CurrencyError(`Expected USD base currency but received ${baseCode}.`))
          }

          return Effect.succeed({
            baseCode,
            targetCode,
            rate,
            updatedAt
          })
        })
      )
    })
  )
}

export const CurrencyServiceLive = Layer.succeed(CurrencyService, {
  exchangeRate: getExchangeRate
})

const cacheKeyForCurrency = (code: string) => `currency:usd:${normalizeCurrencyCode(code).toLowerCase()}`

const currencyRateCodeForConversion = (conversion: CurrencyConversion): Effect.Effect<string, CurrencyError> => {
  const fromCode = normalizeCurrencyCode(conversion.fromCode)
  const toCode = normalizeCurrencyCode(conversion.toCode)

  if (!/^[A-Z]{3}$/.test(fromCode) || !/^[A-Z]{3}$/.test(toCode)) {
    return Effect.fail(new CurrencyError("Currency codes must be three letters, like USD, ARS, or EUR."))
  }

  if (fromCode === "USD") {
    return Effect.succeed(toCode)
  }

  if (toCode === "USD") {
    return Effect.succeed(fromCode)
  }

  return Effect.fail(new CurrencyError("Currency conversions currently require USD on one side."))
}

const formatCurrencyAmount = (amount: number, code: string, maximumFractionDigits = 2): string => {
  const normalizedCode = normalizeCurrencyCode(code)

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCode,
      maximumFractionDigits
    }).format(amount)
  } catch {
    return `${amount.toLocaleString("en-US", { maximumFractionDigits })} ${normalizedCode}`
  }
}

const convertedCurrencyAmount = (currency: CurrencyData, conversion: CurrencyConversion): number => {
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

const currencyReport = (currency: CurrencyData, conversion: CurrencyConversion, source: ReportSource): TravelReport => ({
  title: `${normalizeCurrencyCode(conversion.fromCode)} → ${normalizeCurrencyCode(conversion.toCode)}`,
  summary: `${formatCurrencyAmount(conversion.amount, conversion.fromCode)} = ${formatCurrencyAmount(convertedCurrencyAmount(currency, conversion), conversion.toCode)}`,
  source,
  sections: [
    {
      label: "Conversion",
      lines: [
        `${formatCurrencyAmount(conversion.amount, conversion.fromCode)} = ${formatCurrencyAmount(convertedCurrencyAmount(currency, conversion), conversion.toCode)}`
      ]
    },
    {
      label: "Exchange Rate",
      lines: [
        `1 ${currency.baseCode} = ${formatCurrencyAmount(currency.rate, currency.targetCode)}`,
        `1 ${currency.targetCode} = ${formatCurrencyAmount(1 / currency.rate, currency.baseCode, 6)}`
      ]
    },
    {
      label: "Travel Notes",
      lines: [
        "Rates are mid-market estimates, not guaranteed cash exchange rates.",
        "Check your bank/card rate before large purchases.",
        `Updated: ${formatObservedAt(currency.updatedAt)}`,
        `Source: ${source}`
      ]
    }
  ]
})

const currencyErrorReport = (conversion: CurrencyConversion, message: string): TravelReport => ({
  title: `${normalizeCurrencyCode(conversion.fromCode)} → ${normalizeCurrencyCode(conversion.toCode)}`,
  summary: "Could not load exchange rate.",
  source: "fallback",
  sections: [
    {
      label: "Error",
      lines: [message]
    },
    {
      label: "Try",
      lines: ["travel currency ars", "travel currency 100 ars", "travel currency 100 usd ars", "travel currency 100 ars usd"]
    }
  ]
})

export const runCurrency = (conversion: CurrencyConversion): Effect.Effect<TravelReport, never, CacheService | CurrencyService> =>
  Effect.gen(function* () {
    const cache = yield* CacheService
    const currency = yield* CurrencyService

    const rateCodeResult = yield* currencyRateCodeForConversion(conversion).pipe(
      Effect.map((rateCode) => ({ _tag: "Success" as const, rateCode })),
      Effect.catchAll((error) => Effect.succeed({ _tag: "Failure" as const, error }))
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
      Effect.catchAll((error) => Effect.succeed({ _tag: "Failure" as const, error }))
    )

    if (result._tag === "Failure") {
      return currencyErrorReport(conversion, result.error.message)
    }

    yield* cache.set(cacheKey, result.data, currencyCacheTtlMs)

    return currencyReport(result.data, conversion, "live")
  })
