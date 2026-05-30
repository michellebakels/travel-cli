#!/usr/bin/env node

import { Console, Effect } from "effect"

declare const process: {
  argv: ReadonlyArray<string>
  exitCode?: number
}

type TravelCommand =
  | { readonly _tag: "Weather"; readonly city: string }
  | { readonly _tag: "Flight"; readonly from: string; readonly to: string }
  | { readonly _tag: "Packing"; readonly destination: string }
  | { readonly _tag: "Currency"; readonly code: string }
  | { readonly _tag: "Help" }

class CliError {
  readonly _tag = "CliError"

  constructor(readonly message: string) {}
}

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

const describeCommand = (command: TravelCommand): string => {
  switch (command._tag) {
    case "Help":
      return usage
    case "Weather":
      return `Weather command parsed for city: ${command.city}`
    case "Flight":
      return `Flight command parsed for route: ${command.from.toUpperCase()} -> ${command.to.toUpperCase()}`
    case "Packing":
      return `Packing command parsed for destination: ${command.destination}`
    case "Currency":
      return `Currency command parsed for code: ${command.code.toUpperCase()}`
  }
}

const program = parseCommand(process.argv.slice(2)).pipe(
  Effect.map(describeCommand),
  Effect.flatMap(Console.log),
  Effect.catchAll((error) =>
    Console.error(`${error.message}\n\n${usage}`).pipe(
      Effect.tap(() => Effect.sync(() => {
        process.exitCode = 1
      }))
    )
  )
)

Effect.runSync(program)
