import { assertRoot } from '../container-spec'
import { createGate } from './gate'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

const dataRoot = required('TM_DATA_ROOT')
const profileRoot = required('TM_PROFILE_ROOT')
assertRoot('TM_DATA_ROOT', dataRoot)
assertRoot('TM_PROFILE_ROOT', profileRoot)

const gate = createGate({
  dataRoot,
  profileRoot,
  socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  log: (line) => console.log(line)
})

const server = Bun.serve({ port: 2375, fetch: gate })
console.log(`docker gate listening on :${server.port}`)
