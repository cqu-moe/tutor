# Model configuration

Tutor uses Pi 0.82.1 for provider discovery, authentication, model selection, tool execution, and image input. It does not maintain a separate model gateway or key store.

## Selection

- Without `--model`, Tutor selects `magpie/codex/gpt-6.1-sol`.
- With `--model provider/model`, Tutor passes that explicit choice to Pi. Model IDs may themselves contain slashes.
- `--agent-dir` selects an isolated Pi configuration directory for tests or alternate setups. Its `models.json` and `auth.json` are used instead of the default Pi directory.

For example:

```sh
tutor --course "Digital Design" --pdf lecture.pdf --pages 21-24 \
  --agent-dir ~/.pi/tutor --model my-gateway/vision-model
```

This example is configuration syntax only; it is not a claim that every named provider or model has passed Tutor's real-service checks.

## Custom and BYOK services

Add custom OpenAI-compatible, OpenAI Responses, Anthropic Messages, or Google Generative AI services in `<agent-dir>/models.json`. Pi also supports its built-in BYOK providers through their normal environment variables or `auth.json`; no provider-specific Tutor setup is required.

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gateway.example.test/v1",
      "api": "openai-completions",
      "apiKey": "$MY_GATEWAY_API_KEY",
      "models": [
        {
          "id": "vision-model",
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Set `api` and `input` per provider or per model. A gateway can expose multiple protocols and models with different capabilities; Tutor does not assume that all models behind one `baseUrl` share a protocol or accept images.

## Capabilities and materials

Teaching-route prompts attach every original PDF page render and every original screenshot. Tutor rejects the selected model before making a request when its Pi `input` metadata does not include `image`. `.jpg` and `.jpeg` files are sent as `image/jpeg`; other supported CLI image extensions use their lower-case MIME type.

Unknown Pi API identifiers are reported as model configuration failures. Authentication and model HTTP failures keep already prepared course materials, parse results, and `draft.json` available. Published lecture metadata remains in `output/lecture.json`.

## Credentials and diagnostics

Pi resolves credentials from `auth.json`, provider configuration, or environment variables. Keep credentials in the selected Pi agent directory or process environment; do not put them in course directories or this repository.

Model and OCR configuration are independent: `models.json` and `auth.json` control the tutor model, while `MINERU_API_TOKEN` controls MinerU parsing. Tutor redacts configured key, header, token, and sensitive environment values before printing diagnostics. Model request failures expose only a numeric HTTP status when available and fixed authentication, quota or configuration guidance. Arbitrary upstream error text is suppressed, including echoed command-resolved keys. Tutor does not execute credential commands again to collect values for redaction.

## Runtime contract

Route proposal, lecture generation, revision and memory maintenance run through `teachingPrompt` in `src/teaching-model.ts`, which opens `openTutorDurableSession` from `src/durable.ts`. The durable session resolves Pi model/auth configuration, validates image capability, and owns the official conversation and model submission. Stage tools are available only for admitted lecture/revision work; scoped learner-memory tools are bound to the original request's explicit feedback.

Each teaching phase supplies a stable task-derived request/conversation key. `teachingPrompt` first resumes a known submission; otherwise it submits that key and waits for the final answer. The durable boundary rejects incomplete responses and failed memory tools and supplies safe failure diagnostics and any Recovery IDs from successful deletions preceding a failed operation. Keep later tutoring callers on this path: raw SDK errors and partial responses cannot authorize publication. The teaching task owns checkpoints and export reconciliation; a retained model answer alone does not mean a lecture was published.
