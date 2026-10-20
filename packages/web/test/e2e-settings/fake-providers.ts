// Preloaded into the website's process (`bun --preload`) by `serve.ts`. The AI key tester calls fixed provider hosts, so
// this sends those two hosts to the fake provider server named by `TM_E2E_FAKE_PROVIDERS`. Every other request is left alone.
const fakeOrigin = process.env.TM_E2E_FAKE_PROVIDERS
if (!fakeOrigin) throw new Error('TM_E2E_FAKE_PROVIDERS is not set')

const HOSTS: Record<string, string> = {
  'dashscope-intl.aliyuncs.com': '/dashscope',
  'api-inference.modelscope.cn': '/modelscope'
}
const realFetch = globalThis.fetch

globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const prefix = HOSTS[url.hostname]
    if (!prefix) return realFetch(input, init)
    return realFetch(`${fakeOrigin}${prefix}${url.pathname.replace(/^\/(?:compatible-mode\/)?v1/, '')}`, init)
  },
  { preconnect: realFetch.preconnect }
)
