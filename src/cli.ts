import { Effect } from "effect"
import { CacheService } from "./cache.js"
import { CountryService, runCountry } from "./country.js"
import { type CurrencyConversion, CurrencyService, runCurrency } from "./currency.js"
import { renderReport, type TravelReport } from "./report.js"
import { runTime, TimeService } from "./time.js"
import { runWeather, WeatherService } from "./weather.js"

type TravelCommand =
  | { readonly _tag: "Weather"; readonly city: string }
  | { readonly _tag: "Time"; readonly place: string }
  | { readonly _tag: "Country"; readonly country: string }
  | { readonly _tag: "Packing"; readonly destination: string }
  | { readonly _tag: "Currency"; readonly conversion: CurrencyConversion }
  | { readonly _tag: "Help" }

export class CliError {
  readonly _tag = "CliError"

  constructor(readonly message: string) {}
}

export const usage = `travel command center

Usage:
  travel weather <city>
  travel time <place>
  travel country <country>
  travel packing <destination>
  travel currency <code>
  travel currency <amount> <code>
  travel currency <amount> <from> <to>`

const parseCurrencyAmount = (value: string): number | undefined => {
  const amount = Number(value)

  return Number.isFinite(amount) && amount > 0 ? amount : undefined
}

const parseCurrencyCommand = (args: ReadonlyArray<string>): Effect.Effect<TravelCommand, CliError> => {
  const [firstArg, secondArg, thirdArg, extraArg] = args

  if (firstArg === undefined) {
    return Effect.fail(new CliError("Missing currency code for currency command."))
  }

  if (extraArg !== undefined) {
    return Effect.fail(new CliError("Too many arguments for currency command."))
  }

  const amount = parseCurrencyAmount(firstArg)

  if (amount === undefined) {
    return secondArg === undefined
      ? Effect.succeed({ _tag: "Currency", conversion: { amount: 1, fromCode: "USD", toCode: firstArg } })
      : Effect.succeed({ _tag: "Currency", conversion: { amount: 1, fromCode: firstArg, toCode: secondArg } })
  }

  if (secondArg === undefined) {
    return Effect.fail(new CliError("Missing currency code after amount."))
  }

  return Effect.succeed({
    _tag: "Currency",
    conversion: {
      amount,
      fromCode: secondArg,
      toCode: thirdArg ?? "USD"
    }
  })
}

export const parseCommand = (args: ReadonlyArray<string>): Effect.Effect<TravelCommand, CliError> => {
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

    case "time": {
      const place = args.slice(1).join(" ").trim()

      return place.length === 0
        ? Effect.fail(new CliError("Missing place for time command."))
        : Effect.succeed({ _tag: "Time", place })
    }

    case "country": {
      const country = args.slice(1).join(" ").trim()

      return country.length === 0
        ? Effect.fail(new CliError("Missing country for country command."))
        : Effect.succeed({ _tag: "Country", country })
    }

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

const notImplementedReport = (command: Exclude<TravelCommand, { readonly _tag: "Weather" } | { readonly _tag: "Time" } | { readonly _tag: "Country" } | { readonly _tag: "Currency" } | { readonly _tag: "Help" }>): TravelReport => ({
  title: `${command._tag} is not implemented yet`,
  summary: "We are building this CLI one command at a time. Weather, time, country, and currency work first.",
  source: "fallback",
  sections: [
    {
      label: "Next",
      lines: ["Run: travel weather miami", "Run: travel time tokyo", "Run: travel country argentina", "Run: travel currency ars"]
    }
  ]
})

export const runCommand = (command: TravelCommand): Effect.Effect<string, never, CacheService | WeatherService | TimeService | CountryService | CurrencyService> => {
  switch (command._tag) {
    case "Help":
      return Effect.succeed(usage)
    case "Weather":
      return runWeather(command.city).pipe(Effect.map(renderReport))
    case "Time":
      return runTime(command.place).pipe(Effect.map(renderReport))
    case "Country":
      return runCountry(command.country).pipe(Effect.map(renderReport))
    case "Currency":
      return runCurrency(command.conversion).pipe(Effect.map(renderReport))
    case "Packing":
      return Effect.succeed(renderReport(notImplementedReport(command)))
  }
}
