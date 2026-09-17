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

Reasoning_content stays outside the transcript and is never replayed into subsequent requests. If the endpoint doesn't emit a reasoning field, separation is reported n/a rather than claiming it was tested.

## Capacity and limits

Choose context length, quantization and GPU allocation for your real model. There is no universal 32k/VRAM setting that guarantees review quality on GB10.

Planning uses file metadata; repository tools return bounded context. There are ≤6 batches, ≤50 steps each, a bounded transcript, focused critic calls for suggestions, and final-answer generation. This can be more than a handful of inference requests.

The shared wall-clock budget covers authorization/preflight, Git/fetch, discovery/probes, planning, batch calls, critic, retry sleeps and publishing. Up to 60 seconds (or 10% for shorter runs) is reserved for deterministic host finalization. Budget exhaustion yields partial, not a clean result. Checkout/Tailscale setup outside the worker is separately bounded by the workflow job timeout.
