#!/usr/bin/env node

import { Console, Effect, Layer } from "effect"
import { AdvisoryServiceLive } from "./advisory.js"
import { CacheServiceLive } from "./cache.js"
import { parseCommand, runCommand, usage } from "./cli.js"
import { CountryServiceLive } from "./country.js"
import { CurrencyServiceLive } from "./currency.js"
import { HolidayServiceLive } from "./holidays.js"
import { TimeServiceLive } from "./time.js"
import { WeatherServiceLive } from "./weather.js"

const AppLayer = Layer.mergeAll(CacheServiceLive, WeatherServiceLive, TimeServiceLive, CountryServiceLive, AdvisoryServiceLive, HolidayServiceLive, CurrencyServiceLive)

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
