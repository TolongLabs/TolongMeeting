// Adds a member by GitHub login, which is how anyone gets in (there is no public sign-up). The first admin is made here:
//   bun run packages/web/scripts/add-member.ts --login <github-login> --name "<display name>" [--tz <IANA zone>] [--admin]
// Needs DATABASE_URL. The person signs in with GitHub afterwards; sign-in links the account and checks the organisation.
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { addMember } from '../lib/scope'

const USAGE = 'Usage: add-member.ts --login <github-login> --name "<display name>" [--tz <IANA zone>] [--admin]'

const ArgsSchema = z.object({
  login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'not a GitHub login'),
  name: z.string().trim().min(1),
  tz: z
    .string()
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone })
        return true
      } catch {
        return false
      }
    }, 'not an IANA time zone')
    .optional(),
  admin: z.boolean().optional()
})

const { values } = parseArgs({
  options: {
    login: { type: 'string' },
    name: { type: 'string' },
    tz: { type: 'string' },
    admin: { type: 'boolean' }
  },
  strict: true
})

const parsed = ArgsSchema.safeParse(values)
if (!parsed.success) {
  console.error(`${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('\n')}\n${USAGE}`)
  process.exit(2)
}

const { login, name, tz, admin } = parsed.data
const member = await addMember({
  githubLogin: login,
  displayName: name,
  ...(tz ? { timeZone: tz } : {}),
  role: admin ? 'admin' : 'member'
})
console.log(
  `Added ${login.toLowerCase()} as ${admin ? 'admin' : 'member'} (${member.id}). They can now sign in with GitHub.`
)
// The database pool would keep the process alive.
process.exit(0)
