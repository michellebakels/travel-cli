import { Context, Effect, Layer } from "effect"
import { CacheService } from "./cache.js"
import { fetchJson as fetchJsonRequest } from "./http.js"
import { isRecord } from "./json.js"
import { formatObservedAt, type ReportSource, type TravelReport } from "./report.js"

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

class WeatherError {
  readonly _tag = "WeatherError"

  constructor(readonly message: string) {}
}

export class WeatherService extends Context.Tag("WeatherService")<
  WeatherService,
  {
    readonly current: (city: string) => Effect.Effect<WeatherData, WeatherError>
  }
>() {}

const weatherCacheTtlMs = 30 * 60 * 1000

const fetchJson = (url: string): Effect.Effect<unknown, WeatherError> =>
  fetchJsonRequest(url, {
    service: "Weather service",
    makeError: (message) => new WeatherError(message)
  })

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

export const WeatherServiceLive = Layer.succeed(WeatherService, {
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

const formatTemperature = (celsius: number): string => {
  const fahrenheit = (celsius * 9) / 5 + 32

  return `${Math.round(celsius)}C / ${Math.round(fahrenheit)}F`
}

const weatherReport = (weather: WeatherData, source: ReportSource): TravelReport => ({
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
        `Wind: ${weather.windKph} km/h`
      ]
    },
    {
      label: "Meta",
      lines: [
        `Observed at: ${formatObservedAt(weather.observedAt)}`,
        `Source: ${source}`
      ]
    }
  ]
})

export const runWeather = (city: string): Effect.Effect<TravelReport, never, CacheService | WeatherService> =>
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
