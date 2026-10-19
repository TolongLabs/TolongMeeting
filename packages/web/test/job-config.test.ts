import { expect, test } from 'bun:test'
import { aiConfigFor, DEFAULT_MODELS } from '../db/job-config'

test('AI config uses the Singapore endpoints', () => {
  expect(aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: null })).toEqual({
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-test',
    asrUrl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
    models: DEFAULT_MODELS
  })
  expect(aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: 'ws-abc123' })).toMatchObject({
    baseUrl: 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    asrUrl: 'wss://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime'
  })
})

test('AI config refuses a Workspace ID that could change the host', () => {
  expect(() => aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: 'evil.example/x' })).toThrow(
    'Workspace ID is not a plain identifier'
  )
})
