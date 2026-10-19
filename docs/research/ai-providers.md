# AI providers

The options for members who bring their own Alibaba Cloud Model Studio (DashScope) or ModelScope key, researched on 20 October 2026, and the defaults the design takes from them. Official Alibaba pages were fetched; ModelScope's documentation didn't render, so its facts come from secondary sources and are flagged. Model names and prices change often; re-check at build time.

Contents:

1.  [Endpoints and keys](#endpoints-and-keys)
1.  [Text and vision models](#text-and-vision-models)
1.  [Speech recognition](#speech-recognition)
1.  [ModelScope](#modelscope)
1.  [Data use](#data-use)
1.  [Defaults chosen](#defaults-chosen)

## Endpoints and keys

- **Singapore (international)**: OpenAI-compatible base URL `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. For production, Alibaba recommends the workspace endpoint `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` ([base URLs](https://www.alibabacloud.com/help/en/model-studio/base-url)).
- **Beijing (mainland China)**: `https://dashscope.aliyuncs.com/compatible-mode/v1`.
- **Keys are tied to a region**: using a key against another region's URL returns 401.
- **Sign-up**: by email or mobile, with the phone number matching the chosen country; a secondary guide says a card is required. Malaysia-specific identity rules weren't confirmed.

## Text and vision models

Singapore prices in US dollars per million input and output tokens, from Alibaba's [pricing page](https://www.alibabacloud.com/help/en/model-studio/model-pricing) (updated 19 October 2026):

| Use                                  | Model           | Price (input / output)                                                     | Context    | Note                                                                       |
| ------------------------------------ | --------------- | -------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| Lecture and meeting summaries        | `qwen3.7-plus`  | $0.40 / $1.60 (up to 256K input)                                           | Up to 1M   | A 20,000-word transcript costs about 2 cents                               |
| Slide reading (vision)               | `qwen3-vl-plus` | $0.20 / $1.60 (up to 32K); $0.30 (32K to 128K); $0.60 (128K to 256K) input | Up to 256K | Newer vision models exist and weren't priced                               |
| Matching form labels to saved fields | `qwen-flash`    | $0.05 / $0.40 (up to 256K)                                                 | 1M         | [Model page](https://www.alibabacloud.com/help/en/model-studio/qwen-flash) |

Third-party guides quote other names and prices (for example `qwen3.8-flash` at $0.15 / $0.47). Model lists change about every quarter.

## Speech recognition

- **Live**: `qwen3-asr-flash-realtime` over WebSocket, not stated to be OpenAI Realtime-compatible. The Singapore URL is `wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime` ([model page](https://www.alibabacloud.com/help/en/model-studio/qwen3-asr-flash-realtime), [Python SDK](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-realtime-python-sdk)).
  - **Audio**: PCM (the default) or Opus, at 16 kHz by default; 8 kHz input is upsampled. The sample uses mono 16-bit PCM.
  - **Languages**: 27, including English, Malay, Indonesian and Chinese.
  - **Price**: the English page says US$0.00009 a second, about US$0.32 an hour. The Chinese page says 0.00066 CNY a second, about 2.38 CNY an hour. These conflict; check the console.
  - **Rate limit**: 1,200 requests a minute.
- **From a file**: `qwen3-asr-flash-filetrans`, US$0.000035 a second in Singapore (about US$0.13 an hour). Formats, maximum length and protocol weren't stated ([model page](https://www.alibabacloud.com/help/en/model-studio/qwen3-asr-flash-filetrans)).
- Paraformer real-time wasn't verified, because its page didn't render.

## ModelScope

- **Quota**: conflicting secondary reports. One says 2,000 calls a day, reset at midnight Malaysia time, then 429 errors ([Cherry Studio docs](https://docs.cherry-ai.com/en-us/pre-basic/providers/modelscope)). A 2026 post says 250 credits a day at 2 credits a call on some models, about 125 calls ([source](https://www.80aj.com/2026/08/11/modelscope-free-api-deepseek-kimi/)). Users also report per-model limits of 500 a day and 429 errors below quota.
- **Account**: secondary sources say it needs an Alibaba Cloud account with real-name verification.
- **Reliability**: no service guarantee was found and the free quota changes, so it suits development and fallback only.
- **Base URL and terms**: not verified from official pages.

## Data use

- Alibaba's [data retention policy](https://www.alibabacloud.com/help/en/model-studio/data-retention-policy) (updated 1 October 2026) keeps prompts and responses for up to 30 days by default, and doesn't use business inputs and outputs to train foundation models without consent. Zero data retention is offered to enterprise international API customers.
- ModelScope's terms weren't checked.

## Defaults chosen

The design (decisions 31, 34 and 35) uses each member's own DashScope key in the Singapore region:

- **Summaries**: `qwen3.7-plus`.
- **Slide reading**: `qwen3-vl-plus`.
- **Form-label matching**: `qwen-flash`.
- **Live speech recognition**: `qwen3-asr-flash-realtime`, so one key covers every cloud AI task.
- **ModelScope**: a fallback for text tasks only, never the sole route for time-critical form matching.

At these prices a 2-hour lecture costs a member roughly US$0.70, most of it for live speech recognition; native mode removes that part.
