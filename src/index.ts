#!/usr/bin/env node

import { Console, Effect, Layer } from "effect"
import { CacheServiceLive } from "./cache.js"
import { parseCommand, runCommand, usage } from "./cli.js"
import { CurrencyServiceLive } from "./currency.js"
import { TimeServiceLive } from "./time.js"
import { WeatherServiceLive } from "./weather.js"

const AppLayer = Layer.mergeAll(CacheServiceLive, WeatherServiceLive, TimeServiceLive, CurrencyServiceLive)

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
