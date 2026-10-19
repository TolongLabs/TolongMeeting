import { assertRoot } from '../container-spec'
import { serveGate } from './gate'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

const dataRoot = required('TM_DATA_ROOT')
const profileRoot = required('TM_PROFILE_ROOT')
assertRoot('TM_DATA_ROOT', dataRoot)
assertRoot('TM_PROFILE_ROOT', profileRoot)

const server = serveGate({
  port: 2375,
  dataRoot,
  profileRoot,
  publicUrl: required('TM_PUBLIC_URL'),
  ntfyUrl: required('NTFY_URL'),
  socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  log: (line) => console.log(line)
})
console.log(`docker gate listening on :${server.port}`)
