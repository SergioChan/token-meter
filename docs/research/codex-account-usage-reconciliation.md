# Codex account-usage reconciliation

Last verified: 2026-08-05

## Executive finding

`account/usage/read` cannot return backend usage for a particular Codex session or turn. Its request has no parameters, and its response contains only an account-level summary plus optional daily buckets. It has no `threadId`, `turnId`, `responseId`, model, token-class breakdown, timezone, or attribution field. The official app-server documentation describes it as ChatGPT account token activity, not thread telemetry ([Codex App Server: token usage](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt)).

The comparable local surface is different: `/status` reports current-session token usage, while `thread/tokenUsage/updated` reports a thread and turn identifier together with local cumulative and latest-completion usage ([Codex developer commands](https://learn.chatgpt.com/docs/developer-commands#inspect-the-session-with-status), [thread protocol](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1576-L1646)). Therefore a rollout's `total_token_usage` and `/usage` are not two representations of the same ledger row. Exact backend-to-session reconciliation is not available through the public protocol.

## Evidence scope

This report uses only first-party evidence:

- the current official Codex documentation;
- protocol and TypeScript bindings generated locally from the Codex desktop app's bundled app-server binary; and
- the public `openai/codex` source at commit [`ad6e48d`](https://github.com/openai/codex/commit/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60), with the installed app release matched to [`8ac92db`](https://github.com/openai/codex/commit/8ac92dbc9066214ecf51be42584e3da83a22157e).

The inspected desktop binary reported `codex-cli 0.147.0-alpha.1.2`. Its protocol was generated with:

```text
/Applications/ChatGPT.app/Contents/Resources/codex app-server \
  generate-json-schema --experimental --out <temporary-directory>
/Applications/ChatGPT.app/Contents/Resources/codex app-server \
  generate-ts --experimental --out <temporary-directory>
```

The generated bindings exposed these relevant shapes:

```ts
type ThreadTokenUsageUpdatedNotification = {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
};

type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

type GetAccountTokenUsageResponse = {
  summary: AccountTokenUsageSummary;
  dailyUsageBuckets: AccountTokenUsageDailyBucket[] | null;
};

type AccountTokenUsageDailyBucket = {
  startDate: string;
  tokens: bigint;
};
```

The generated `account/usage/read` request has `params: undefined`/JSON `null`. The same contract is present in source: the request macro accepts no parameters ([request definition](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/app-server-protocol/src/protocol/common.rs#L1081-L1095)), and the response type contains only `summary` and `daily_usage_buckets` ([account protocol](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L389-L448)).

## Confirmed facts

### 1. Local rollout token semantics

In the normal model-response path, Codex receives one provider-reported usage object for each completed upstream Responses request. It copies `input_tokens`, cached-input details, output details, and `total_tokens` into `TokenUsage` ([Responses usage parser](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/codex-api/src/sse/responses.rs#L123-L148)). Codex then appends that object element by element to the thread's cumulative usage and replaces `last_token_usage` with that latest object ([usage accumulation](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/protocol/src/protocol.rs#L2065-L2130), [element-wise addition](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/protocol/src/protocol.rs#L2274-L2284)).

The fields therefore mean:

| Field | Confirmed meaning |
| --- | --- |
| `total_token_usage` | Normally, the element-wise cumulative sum of upstream completion-usage objects recorded in that local thread. It is not account-wide. |
| `last_token_usage` | Normally, the usage of the most recently completed upstream Responses request. It is not necessarily the whole user turn. |
| `input_tokens` | Provider-reported input tokens. This includes the cached-input subset. |
| `cached_input_tokens` | Input tokens read from prompt cache. This is a detail/subset, not an additional count to add to `input_tokens`. |
| `cache_write_input_tokens` | Input tokens written to prompt cache when the provider reports them. The installed desktop schema includes this field. |
| `output_tokens` | Provider-reported output tokens. |
| `reasoning_output_tokens` | The reasoning-token detail within output usage, not an extra category to add again. |
| `total_tokens` | The provider-reported total for the completion; Codex copies rather than recomputes it. |

The inclusion relationship is explicit in source: non-cached input is calculated as `input_tokens - cached_input_tokens`, and Codex has a separate display helper, `blended_total`, equal to non-cached input plus output ([token helpers](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/protocol/src/protocol.rs#L2229-L2243)). The rollout's `total_token_usage.total_tokens` is not that blended display value; it accumulates the upstream raw `total_tokens` field.

One user turn can make several upstream Responses requests, for example after tool calls or other required follow-up work. The turn runner explicitly loops while follow-up is needed ([turn sampling loop](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/core/src/session/turn.rs#L272-L465)), and each completed response records another usage object ([completion handling](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/core/src/session/turn.rs#L2494-L2537)). Thus `last_token_usage` means latest model completion even though the app-server notification also carries the enclosing `turnId`.

`TokenCount` is also not a billing-grade event. The source calls `RawResponseCompleted` the exact usage from one upstream completion and explicitly contrasts it with `TokenCountEvent`, which may be accumulated, estimated, or replayed ([exact-response event](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/protocol/src/protocol.rs#L1827-L1838)). Resume restores the last persisted `TokenCount`, and local recomputation can install an estimated context count ([resume and recomputation](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/core/src/session/mod.rs#L1239-L1248), [estimated usage path](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/core/src/session/mod.rs#L3818-L3860)). `TokenCount` events are intentionally persisted to rollouts ([rollout persistence policy](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/rollout/src/policy.rs#L85-L104)).

Consequently, a local analyzer should treat the latest cumulative value as thread telemetry and use guarded positive deltas for interval estimates. It should not sum every `TokenCount` snapshot, and it should preserve reset/replay/estimate caveats.

### 2. Account usage semantics and granularity

`account/usage/read` fetches an authenticated account profile, not local rollout state. The backend client calls the account-profile route (`.../profiles/me`) ([backend client](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/backend-client/src/client.rs#L327-L341)). The backend response type has only lifetime/peak/streak/task summary values and optional daily buckets ([backend profile type](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/backend-client/src/types.rs#L502-L521)). App-server maps those fields directly into the public response without calculating token values locally ([account processor](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/app-server/src/request_processors/account_processor.rs#L1120-L1152), [field mapping](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/app-server/src/request_processors/account_processor.rs#L1195-L1215)).

The confirmed granularity is:

- `summary.lifetimeTokens`: one nullable account-level lifetime value;
- `summary.peakDailyTokens`: one nullable account-level peak-day value;
- `dailyUsageBuckets`: a nullable list of date-only `{startDate, tokens}` buckets; and
- no server-side weekly, cumulative-window, session, turn, response, model, or token-class series.

The TUI's `/usage daily`, `/usage weekly`, and `/usage cumulative` choices do not change the backend request. They are client-side views over the same daily buckets. Current source renders a fixed 52-week chart, sums seven daily cells for weekly columns, and computes cumulative mode as a running sum of those weekly values ([view definitions](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/tui/src/chatwidget/tokens/chart.rs#L31-L84), [daily and weekly aggregation](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/tui/src/chatwidget/tokens/chart.rs#L379-L466)). Therefore `/usage cumulative` is a chart transformation over returned daily history; it is not a parameterized backend query and is distinct from the separate `lifetimeTokens` summary.

### 3. Cached input is discounted economically, but the account token formula is not public

Official Codex pricing confirms that credits are calculated separately for input, cached input, and output, with cached reads priced below uncached input ([Codex pricing](https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits)). The prompt-caching documentation likewise says cache hits are billed at the cached-input rate and reports cache reads in `cached_tokens`; recent model families can also report separately priced cache writes ([Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching#how-it-works), [usage fields](https://developers.openai.com/api/docs/guides/prompt-caching#requirements)).

That establishes a discount for credit consumption. It does **not** establish how `account/usage/read` constructs its field named `tokens`. Neither the public response schema nor the open-source client defines a weighting, normalization baseline, model conversion, Fast-mode multiplier, rounding rule, or cache-write treatment. The client only forwards backend-provided integers.

Accordingly:

- confirmed: local `total_token_usage.total_tokens` counts cached input at its full provider-reported token count;
- confirmed: cached reads have a lower credit rate than uncached input;
- unknown: whether account-profile `tokens` are raw tokens, credit-weighted/normalized units displayed as tokens, or another server-side activity measure; and
- unknown: the exact treatment of cache writes in account-profile token activity.

### 4. Request-body compression exists, but it is transport compression

Current Codex has a stable `enable_request_compression` feature that is enabled by default ([feature definition](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/features/src/lib.rs#L1083-L1088)). For an OpenAI provider using Codex-backend authentication, Codex selects zstd compression; API-key-only requests do not take this path ([selection logic](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/core/src/client.rs#L1378-L1387)). The HTTP client compresses the encoded JSON bytes, sets `Content-Encoding: zstd`, and emits a debug trace containing pre-compression bytes, post-compression bytes, and duration ([HTTP preparation](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/http-client/src/request.rs#L192-L224)).

This feature changes wire bytes, not model input tokens. It is observable through the HTTP header, transport inspection, or the debug trace. It is not exposed in `TokenCount`, `thread/tokenUsage/updated`, or `account/usage/read`, and no compression ratio can be reconstructed from those token events. It must also not be confused with conversation-history compaction (`thread/compact/start`), which changes model-visible history and is surfaced as a context-compaction item ([Codex App Server: thread compaction](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)).

### 5. Date and timezone boundaries are only partly defined

The account protocol provides `startDate` as a date string and provides no timezone, UTC offset, bucket end, or locale. App-server does not transform it. Current TUI code uses `Utc::now().date_naive()` as its notion of today ([TUI date selection](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/tui/src/chatwidget/tokens.rs#L68-L86)), parses bucket dates as `%Y-%m-%d`, and aligns weekly columns to Sunday ([bucket parsing and chart boundary](https://github.com/openai/codex/blob/ad6e48ddd35af1ab477d417ceb1becb5dbb96a60/codex-rs/tui/src/chatwidget/tokens/chart.rs#L379-L466)).

This confirms the TUI's rendering boundary. It does not prove that the backend assigns usage to calendar days in UTC. The backend bucket timezone, daylight-saving behavior, ingestion cutoff, and late-event/backfill policy remain undocumented. A local comparison sliced at Pacific midnight and one sliced at UTC midnight can therefore produce materially different raw totals without either matching the backend's undisclosed boundary.

## Empirical and inferred behavior

The following observations came from a private local audit. Exact account totals are intentionally omitted from this repository.

1. In the inspected account response, the sum of returned non-empty daily buckets equaled the returned lifetime value. This is useful consistency evidence for that snapshot, but the schema does not promise complete lifetime bucket coverage.
2. For one audited day, guarded positive deltas from local rollout cumulative counters were substantially larger than the backend daily account bucket. Cached input dominated the local raw count. The result changed materially when the same local events were partitioned at UTC midnight instead of Pacific midnight.
3. Reconstructing a model-aware activity value with the current public input/cached-input/output credit weights moved the local estimate much closer to the backend bucket than the raw-token sum did. This is consistent with a credit-weighted or normalized account metric, but it does not prove one. Other-device activity, deleted or unavailable rollouts, cloud work, model/version differences, Fast mode, cache writes, backend delay, and the unknown day boundary make the observation underdetermined.

The conservative conclusion is therefore not a formula. It is that raw local cumulative tokens are empirically the wrong quantity to equate directly with account token activity, and the public sources do not expose the server-side conversion needed to derive one from the other.

## Unknowns that prevent exact reconciliation

- The server-side definition and unit of account-profile `tokens`.
- Whether and how cached reads, cache writes, model rates, reasoning, tools, image generation, and Fast mode are normalized into that value.
- The backend timezone and exact daily bucket boundary.
- Ingestion delay, corrections, and backfill behavior.
- The complete product-surface scope included in lifetime and daily activity.
- A backend event identifier that joins an account bucket to a local `threadId`, `turnId`, or `responseId`.

Because these fields are absent, a daily bucket delta cannot be attributed exactly to one session even if only one visible local task appears active. It remains an account aggregate over an undisclosed server-side metering pipeline.

## Recommended product semantics

Token Meter should present the two surfaces as intentionally different metrics:

| Product label | Source | Safe interpretation |
| --- | --- | --- |
| Local thread raw tokens | `thread/tokenUsage/updated` or rollout `token_count` | Provider-reported local thread telemetry, accumulated across model completions; cached input is included at full token count. |
| Local turn estimate | Guarded positive deltas within a known turn boundary | An estimate over one local turn; still subject to replay, estimation, compaction, and child-thread policy. |
| Account token activity | `account/usage/read` | Backend account-level lifetime and date-bucket activity in an undocumented server-defined token unit. |
| Credits/limits | Official pricing and account rate-limit surfaces | Economic consumption; model- and token-class-dependent, not interchangeable with raw token counts. |

The UI should not label `/usage` as backend usage for the selected session, and it should not show an exact reconciliation error between local raw totals and account activity. A defensible comparison can show direction or coarse correlation, with explicit boundary and coverage caveats.

Exact reconciliation would require a new backend contract that returns per-event or per-thread metering records with at least `threadId`, `turnId`, `responseId`, timestamp, model/service tier, raw input/cache-read/cache-write/output counts, normalized account units, normalization version, and bucket timezone. None of those attribution fields are available from `account/usage/read` today.
