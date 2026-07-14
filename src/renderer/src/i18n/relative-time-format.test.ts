import { describe, expect, it, vi } from 'vitest'

const mockI18n = { language: 'en', resolvedLanguage: 'en' as string | undefined }

vi.mock('./i18n', () => ({ i18n: mockI18n }))

import { getUiRelativeTimeFormatter } from './relative-time-format'

describe('getUiRelativeTimeFormatter', () => {
  it('formats with the configured UI language instead of the OS locale', () => {
    mockI18n.resolvedLanguage = 'en'
    expect(getUiRelativeTimeFormatter().format(-1, 'day')).toBe('yesterday')
  })

  it('reuses the cached formatter while the language is unchanged', () => {
    mockI18n.resolvedLanguage = 'en'
    expect(getUiRelativeTimeFormatter()).toBe(getUiRelativeTimeFormatter())
  })

  it('rebuilds the formatter after a runtime language switch', () => {
    mockI18n.resolvedLanguage = 'en'
    const english = getUiRelativeTimeFormatter()
    mockI18n.resolvedLanguage = 'ko'
    const korean = getUiRelativeTimeFormatter()
    expect(korean).not.toBe(english)
    expect(korean.format(-1, 'day')).toBe('어제')
  })

  it('falls back to the active language when resolvedLanguage is unset', () => {
    mockI18n.resolvedLanguage = undefined
    mockI18n.language = 'ja'
    expect(getUiRelativeTimeFormatter().format(-1, 'day')).toBe('昨日')
  })
})
