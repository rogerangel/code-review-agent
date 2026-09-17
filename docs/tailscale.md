# Tailscale runner access

The reusable workflow uses Tailscale v4 workload identity federation: oauth-client-id, audience and tags, with id-token: write. The older oidcProvider/oidcRole inputs do not exist. A supported Node 24 runner is required (GitHub-hosted ubuntu-latest works).

Use the [official Action instructions](https://tailscale.com/docs/integrations/github/github-action) for current runner requirements and authentication options.

## 1. Define narrow access

Create tag:code-review-agent for ephemeral review runners. Assign the LLM host an appropriate existing server tag, or use its stable Tailscale IP as the destination. This example assumes the GB10 has tag:vllm and listens on TCP 8123:

~~~json
{
  "tagOwners": {
    "tag:code-review-agent": ["autogroup:admin"],
    "tag:vllm": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:code-review-agent"],
      "dst": ["tag:vllm"],
      "ip": ["tcp:8123"]
    }
  ]
}
~~~

MERGE this into your policy; do not overwrite unrelated rules. Review existing broad grants/ACLs too: access is additive. Tagging an existing personal device can change its identity/access; using the existing host tag or explicit IP may be preferable. Validate with tailnet policy tests and the GB10 firewall. Do not enable Funnel/public port forwarding for vLLM.

See [Tailscale grant examples](https://tailscale.com/docs/reference/examples/grants) for network policy syntax.

## 2. Create a federated trust credential

With tailnet administrative access, open Trust credentials → Credential → OpenID Connect. Select GitHub's issuer (https://token.actions.githubusercontent.com), enable auth_keys write, and constrain generated node tags to tag:code-review-agent. Copy the generated Client ID and Audience; do not invent an audience string.

Restrict trust to the TARGET/CALLER repository, not just the repository that hosts reviewer source. For conventional default GitHub subjects, an illustrative pattern is repo:OWNER/TARGET_REPO:*. Add exact custom claims such as:

~~~text
repository       = OWNER/TARGET_REPO
job_workflow_ref = rogerangel/code-review-agent/.github/workflows/code-review-agent.yml@REVIEWER_COMMIT_SHA
job_workflow_sha = REVIEWER_COMMIT_SHA
~~~

Replace the SHA with your verified commit. Match the actual subject format used by your repo: GitHub supports customized and immutable/ID-bearing subjects, so do not assume the illustrative subject is universal. If restrictions distinguish PR events from default-branch comment events, allow BOTH intended contexts. Do not log JWTs to diagnose this.

These claim restrictions are our suggested deployment policy; see [Tailscale federation setup](https://tailscale.com/docs/features/workload-identity-federation) and [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).

Create a separate restricted identity per caller repo initially. When updating the reviewer SHA, update its Tailscale claim restriction too.

## 3. Add caller repository secrets

In the target repo's Settings → Secrets and variables → Actions:

~~~text
TS_CLIENT_ID = generated federated Client ID
TS_AUDIENCE  = generated Audience
~~~

These are non-secret identifiers, stored as secrets here to simplify workflow forwarding. Map them to tailscale_client_id and tailscale_audience in [the caller workflow](caller-workflow.md). No TS_OIDC_ROLE, admin API key, or long-lived OAuth secret is used.

The approved review job performs:

~~~yaml
- uses: tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8 # verified v4
  with:
    oauth-client-id: ${{ secrets.tailscale_client_id }}
    audience: ${{ secrets.tailscale_audience }}
    tags: ${{ inputs.tailscale_tags }}
~~~

Do not put the Tailscale step before authorization. The supplied workflow also checks that the snapshot still matches the gate's SHA before connecting.

## Verify

From an authorized tailnet node, test the real inference URL:

~~~bash
curl --fail --max-time 10 http://gb10.YOUR-TAILNET.ts.net:8123/v1/models
~~~

A runner connection still needs the correct effective grant and reachable API listener. To diagnose OIDC failures, inspect the trust credential's error details in the Tailscale console rather than printing tokens. Ephemeral runner nodes log out during Action cleanup.
