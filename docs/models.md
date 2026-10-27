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

Unknown Pi API identifiers are reported as model configuration failures. Authentication and model HTTP failures keep already prepared course materials, parse results, and `context.json` available.

## Credentials and diagnostics

Pi resolves credentials from `auth.json`, provider configuration, or environment variables. Keep credentials in the selected Pi agent directory or process environment; do not put them in course directories or this repository.

Model and OCR configuration are independent: `models.json` and `auth.json` control the tutor model, while `MINERU_API_TOKEN` controls MinerU parsing. Tutor redacts configured key, header, token, and sensitive environment values before printing diagnostics. Model request failures expose only a numeric HTTP status when available and fixed authentication, quota or configuration guidance. Arbitrary upstream error text is suppressed, including echoed command-resolved keys. Tutor does not execute credential commands again to collect values for redaction.

## Runtime contract

Internal Tutor callers create sessions through `createTutorSession(courseDir, agentDir, model, options)` in `src/runtime.ts`. It resolves the default or explicit model, validates image capability, configures Pi resources, and returns an `AgentSession`. This keeps route proposal and later lecture-generation phases on the same model and authentication path.

Run prompts through `promptWithMemory(session, prompt, options)` from `src/memory.ts` to get the final answer only after normal completion and successful memory tools. The helper also supplies safe model failure diagnostics and any Recovery IDs from successful deletions preceding a failed operation. Lecture and later tutoring callers must use it instead of exposing raw SDK errors or partial responses.
