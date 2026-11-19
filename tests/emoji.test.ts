import { expect, it } from 'vitest'
import { normalizeCategoryEmoji } from '../src/domain/emoji'

it.each(['📦', '👨‍🍳', '👩🏽‍💻', '🇷🇺', '🏳️‍🌈', '1️⃣', '❤️', '🧑🏿‍🤝‍🧑🏻', '🫩', '🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}'])(
  'сохраняет эмодзи %s целиком', emoji => {
    expect(normalizeCategoryEmoji(' ' + emoji + ' ')).toBe(emoji)
  },
)

it.each(['текст', '🍎🥐', '👨‍🍳 🇷🇺', 'еда 🥗', '3', '#', '🇷', '👨‍', '🏽', '🍎\u0301', '👩‍a'])(
  'отклоняет текст, несколько эмодзи и неполные последовательности %s', input => {
    expect(normalizeCategoryEmoji(input)).toBeNull()
  },
)

it('подставляет нейтральный эмодзи для пустого поля', () => {
  expect(normalizeCategoryEmoji('  ')).toBe('📦')
})
