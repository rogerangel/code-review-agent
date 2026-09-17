# vLLM and your GB10

The reviewer uses /v1/models and /v1/chat/completions, not a vendor-specific model SDK. Use the model ID actually served by your endpoint; there is no hardcoded Qwen name or assumed GB10 launch configuration.

Keep your working server setup. If configuring a new one, an illustrative command is:

~~~bash
vllm serve YOUR_MODEL_PATH_OR_ID \
  --served-model-name YOUR-SERVED-MODEL-ID \
  --host YOUR_GB10_TAILSCALE_IP \
  --port 8123 \
  --enable-auto-tool-choice \
  --tool-call-parser YOUR_MODEL_MATCHING_PARSER
~~~

Replace every placeholder. Parser names, chat templates and reasoning parsers depend on the actual model and installed vLLM version; don't reuse a Qwen parser for unrelated models. Automatic native function calling needs corresponding server support. See [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/) for the installed-version/model combination.

No reviewer-owned shell/test tool is exposed to the model. vLLM only predicts tool calls; this host executes the allowed repository/comment handlers.

## Private network

Bind the API to the Tailscale address or a properly isolated private listener, configure the host firewall, and grant runner access only to the inference port. Binding to 127.0.0.1 alone will not make it reachable from the runner.

Do not publish the API using public port forwarding or Tailscale Funnel. An API key is defense in depth, not a substitute for isolation: vLLM documents sensitive endpoints outside API-key protection. See [vLLM security guidance](https://docs.vllm.ai/en/latest/usage/security/).

## Verify capabilities

~~~bash
export CRA_LLM_BASE_URL=http://gb10.YOUR-TAILNET.ts.net:8123/v1
export CRA_LLM_MODEL=YOUR-SERVED-MODEL-ID
node dist/cli.js doctor
~~~

If the server requires a key, set CRA_LLM_API_KEY securely. The reviewer accepts either an origin or the /v1 base path.

Auto mode prefers verified native tools; only a verified schema-output protocol can become the fallback. Doctor tests a COMPLETE tool/result/follow-up round trip, not just one successful first call. Explicit modes still require validation. A 401/403, broken transport, or server failure is not capability fallback.

Both reasoning and the legacy reasoning_content fields are normalized; reasoning stays outside the transcript and is never replayed into subsequent requests. vLLM 0.28.1rc1.dev580+g385dce36b returns reasoning. If neither field is observed, separation is reported n/a rather than claiming thinking was disabled.

## Operator generation settings

Keep the working Docker command initially. Use --llm-options, CRA_LLM_OPTIONS, or the llm_options Action/workflow input for generation controls. CLI flags override the environment; repository configuration cannot supply these settings. Supported JSON keys are max_output_tokens (1-16384), thinking_token_budget (1-16384), chat_template_kwargs (scalar-valued object), temperature (0-2), top_p (>0 to 1), top_k (integer -1 to 1000000), and presence_penalty (-2 to 2). Unknown/invalid settings fail without echoing values.

Default completion caps are 2048 for review, 1024 for planning/critic, 1536 for summary, and 512 for probes. max_output_tokens changes the review cap; other phases keep their smaller ceilings or this value, whichever is lower. Thinking and other provider-specific fields are sent ONLY when explicitly configured. Existing phase sampling defaults remain unless overridden. Doctor verifies configured overrides independently; rejection is not permission to silently discard them.

For the current nvidia/Qwen3.8-27B-NVFP4 deployment, an opt-in bounded-thinking profile is:

~~~bash
export CRA_LLM_OPTIONS='{"thinking_token_budget":1024,"chat_template_kwargs":{"enable_thinking":true},"temperature":1.0,"top_p":0.95,"top_k":20}'
node dist/cli.js doctor
~~~

This keeps thinking enabled and uses the model's recommended thinking-mode sampling. The reasoning cap is 1024 during review, 256 during planning/critic/summary, and 128 during probes, additionally limited to half the completion cap. Other models/providers need their own supported template flags; this example is not a universal configuration. See [Qwen's model instructions](https://huggingface.co/Qwen/Qwen3.8-27B) and [vLLM reasoning budgets](https://docs.vllm.ai/en/latest/features/reasoning_outputs/).

Total completion caps include reasoning and tool/final output. A length-truncated response never executes tools. Review gets one concise-output retry, then partial coverage; planning falls back deterministically, truncated suggestion verification withholds the patch, and truncated summary generation uses a validated deterministic answer. Larger caps are a latency/quality tradeoff, not guaranteed throughput improvements.

An explicit thinking budget requires a completion cap of at least two tokens so some output capacity remains. Tiny caps can still fail capability probes or produce partial reviews.

The reasoning parser separates output; it does not disable thinking. Merely hiding reasoning does not eliminate generation work. Test a non-thinking configuration separately for quality; it is not the default. Use the model's recommended non-thinking sampling too.

Record the running /version response and the running container's image digest before experiments; pin a known-working digest instead of relying indefinitely on the moving nightly tag. Do not restart or change backends just to remove the generation-config warning: explicit request sampling overrides those defaults.

## Capacity and limits

Choose context length, quantization and GPU allocation for your real model. There is no universal 32k/VRAM setting that guarantees review quality on GB10.

Planning uses file metadata; repository tools return bounded context. There are ≤6 batches, ≤50 steps each, a bounded transcript, focused critic calls for suggestions, and final-answer generation. This can be more than a handful of inference requests.

Repository tool results fit within 16000 serialized characters; diffs/listings expose next_offset, and file reads default to at most 200 lines with next_start_line. Search snippets are bounded around matches. Oversized lines and incomplete searches are explicit, never complete-read evidence. Worktree discovery excludes ignored artifacts; explicit safe reads can still inspect dependency/framework references. Old history is compacted above 120000 characters, keeping immutable rules, recent complete tool exchanges, and host checkpoints; the hard ceiling remains 200000 characters. These are character limits, not model token/context-length guarantees.

Prefix-cache hit rate describes reused input work, not decoding acceleration. KV-cache occupancy is not GPU compute utilization. max_model_len is the combined input/output ceiling; gpu_memory_utilization is a memory budget, not a compute throttle; max_num_seqs and max_num_batched_tokens configure concurrency/scheduling, not response length. No setting here alone guarantees higher tokens/second.

The shared wall-clock budget covers authorization/preflight, Git/fetch, discovery/probes, planning, batch calls, critic, retry sleeps and publishing. Up to 60 seconds (or 10% for shorter runs) is reserved for deterministic host finalization. Budget exhaustion yields partial, not a clean result. Checkout/Tailscale setup outside the worker is separately bounded by the workflow job timeout.
