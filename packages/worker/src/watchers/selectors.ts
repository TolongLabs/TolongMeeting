import { z } from 'zod'
import { loadSelectors, selector } from '../adapters/selectors'

// Strict: a key the reader does not use, or a misspelt one, fails when the map loads. Every value is a starting value,
// unverified against the live Discord web app until acceptance (plan 02 task 9).
export const DiscordSelectorsSchema = z
  .object({
    // A note for people; the reader ignores it.
    _unverified: z.string().optional(),
    // The scrolling message list.
    scroller: selector,
    // One rendered message, and what to read inside it.
    message: selector,
    content: selector,
    username: selector,
    time: selector,
    // Shown at the top once the oldest message of the channel is rendered.
    channelStart: selector,
    // The message box. The reader never touches it; the fixture uses it to prove that.
    composer: selector,
    // The sign-in form's email field.
    loginForm: selector
  })
  .strict()
export type DiscordSelectors = z.infer<typeof DiscordSelectorsSchema>

let discord: Promise<DiscordSelectors> | null = null

// Loaded once per process, on first use, from $TM_SELECTORS_DIR/discord.json (default /app/config/selectors).
export function discordSelectors(): Promise<DiscordSelectors> {
  discord ??= loadSelectors('discord', DiscordSelectorsSchema)
  return discord
}
