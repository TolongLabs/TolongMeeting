import { fileURLToPath } from 'node:url'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: fileURLToPath(new URL('./db/schema.ts', import.meta.url)),
  out: fileURLToPath(new URL('./db/migrations', import.meta.url))
})
