import { expect, test } from 'bun:test'
import { normaliseDiscordChannelUrl } from '../src'

const G = '123456789012345678',
  C = '234567890123456789'
test.each([
  [`https://discord.com/channels/${G}/${C}`, `https://discord.com/channels/${G}/${C}`],
  [`https://ptb.discord.com/channels/${G}/${C}/345678901234567890?x=1#y`, `https://discord.com/channels/${G}/${C}`],
  [`https://discordapp.com/channels/@me/${C}/`, `https://discord.com/channels/@me/${C}`],
  ['https://discord.gg/abcdef', null],
  [`https://discord.com.example.com/channels/${G}/${C}`, null],
  [`http://discord.com/channels/${G}/${C}`, null],
  ['https://discord.com/channels/123/456', null],
  [`https://user:pw@discord.com/channels/${G}/${C}`, null],
  [`https://discord.com:8443/channels/${G}/${C}`, null],
  [`https://discord.\tcom/channels/${G}/${C}`, null],
  ['general', null]
])('normaliseDiscordChannelUrl(%s) is %p', (url, want) => expect(normaliseDiscordChannelUrl(url)).toBe(want))
