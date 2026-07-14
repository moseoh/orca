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
