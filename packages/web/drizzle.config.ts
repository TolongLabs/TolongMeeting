import { defineConfig } from 'drizzle-kit'

// Run drizzle-kit from packages/web (`bun run db:generate`): drizzle-kit resolves these paths against the working
// directory, and it breaks an absolute `out` by prefixing it with `./`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations'
})
