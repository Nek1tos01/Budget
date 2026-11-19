import emojiRegex from 'emoji-regex'

export const DEFAULT_CATEGORY_EMOJI = '📦'

const emojiPattern = emojiRegex()
const unicodeEmoji = new RegExp(`^(?:${emojiPattern.source})$`, emojiPattern.flags.replace('g', ''))
const standaloneComponent = /^\p{Emoji_Component}$/u

export function normalizeCategoryEmoji(input: string): string | null {
  const emoji = input.trim()
  if (!emoji) return DEFAULT_CATEGORY_EMOJI
  return unicodeEmoji.test(emoji) && !standaloneComponent.test(emoji) ? emoji : null
}
