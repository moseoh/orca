import { i18n } from './i18n'

// Why: relative times are language words ("2 days ago" / "그저께"), so they must
// follow the configured UI language rather than the OS locale, and the UI
// language can change at runtime — cache per resolved locale, not per module.
let cached: { locale: string | undefined; formatter: Intl.RelativeTimeFormat } | null = null

export function getUiRelativeTimeFormatter(): Intl.RelativeTimeFormat {
  const locale = i18n.resolvedLanguage ?? i18n.language
  if (!cached || cached.locale !== locale) {
    cached = { locale, formatter: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }) }
  }
  return cached.formatter
}

// Format a signed millisecond delta (future positive, past negative) at
// minute/hour/day granularity in the configured UI language.
export function formatUiRelativeTime(diffMs: number): string {
  const formatter = getUiRelativeTimeFormatter()
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }
  return formatter.format(Math.round(diffHours / 24), 'day')
}

// Parse a date string and format it relative to now; returns `fallback` (default
// "recently") when the input isn't a valid date.
export function formatUiRelativeTimeFromDate(input: string, fallback = 'recently'): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }
  return formatUiRelativeTime(date.getTime() - Date.now())
}
