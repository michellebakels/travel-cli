export type ReportSource = "live" | "cache" | "fallback"

export type TravelReport = {
  readonly title: string
  readonly summary: string
  readonly source: ReportSource
  readonly sections: ReadonlyArray<{
    readonly label: string
    readonly lines: ReadonlyArray<string>
  }>
}

export const formatObservedAt = (observedAt: string): string => {
  const date = new Date(observedAt)

  if (Number.isNaN(date.getTime())) {
    return observedAt
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date)
}

export const renderReport = (report: TravelReport): string => {
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
