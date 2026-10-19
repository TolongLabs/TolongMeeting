import type { AiConfig } from '@tm/core'

/** The models the AI calls use. Summary, vision, form matching and live speech. */
export const DEFAULT_MODELS = {
  summary: 'qwen3.7-plus',
  vision: 'qwen3-vl-plus',
  formMatch: 'qwen-flash',
  asr: 'qwen3-asr-flash-realtime'
}

/** A Workspace ID is a plain identifier, so it can't change the host a key is sent to. */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9-]{3,64}$/

const INTERNATIONAL_HOST = 'dashscope-intl.aliyuncs.com'

/**
 * The DashScope config for one member. Without a Workspace ID it uses the Singapore (international) endpoints; with
 * one, the workspace endpoints in the same region.
 */
export function aiConfigFor(k: { dashscopeKey: string; workspaceId: string | null }): AiConfig {
  if (k.workspaceId !== null && !WORKSPACE_ID_PATTERN.test(k.workspaceId)) {
    throw new Error('Workspace ID is not a plain identifier')
  }
  const host = k.workspaceId ? `${k.workspaceId}.ap-southeast-1.maas.aliyuncs.com` : INTERNATIONAL_HOST
  return {
    baseUrl: `https://${host}/compatible-mode/v1`,
    apiKey: k.dashscopeKey,
    asrUrl: `wss://${host}/api-ws/v1/realtime`,
    models: DEFAULT_MODELS
  }
}

// TODO(plan 01c task 14): loadJobConfig (not yet written) maps identities.org_name and org_email_domain to
// identity.organisation (both set or neither) and formProviders from profiles.account_status.
