# LiteLLM Configuration

## Model Definitions

Edit `litellm/config.yaml` to add models:

```yaml
model_list:
  - model_name: deepseek-v4-flash
    litellm_params:
      model: openai/deepseek-v4-flash
      api_base: https://opencode.ai/zen/go/v1
      api_key: os.environ/OPENCODE_GO_API_KEY
```

Supported providers:

| Provider | Model ID | API Base |
|----------|----------|----------|
| OpenCode Go | `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2`, `kimi-k2.7`, `mimo-v2.5` | `https://opencode.ai/zen/go/v1` |
| OpenAI | `gpt-4`, `gpt-3.5-turbo` | `https://api.openai.com/v1` |
| Anthropic | `claude-3` | `https://api.anthropic.com` |

Restart after changes:

```bash
docker compose up -d litellm
```

## Admin API

LiteLLM is available at `http://localhost:4001` with the master key.

```bash
# List keys
curl http://localhost:4001/key/list \
  -H "Authorization: Bearer sk-litellm-master-key-change-me"

# Create user key (key_alias = Keycloak username)
curl -X POST http://localhost:4001/key/generate \
  -H "Authorization: Bearer sk-litellm-master-key-change-me" \
  -d '{"key_alias": "testuser", "max_budget": 50.0}'

# View key info
curl "http://localhost:4001/key/info?key=<hash>" \
  -H "Authorization: Bearer sk-litellm-master-key-change-me"

# Delete key
curl -X POST http://localhost:4001/key/delete \
  -H "Authorization: Bearer sk-litellm-master-key-change-me" \
  -d '{"keys": ["sk-xxx"]}'
```

## Notes

- Models are accessible through the proxy at `http://localhost:4000/v1` (no master key needed — uses JWT auth)
- To add a new model provider, add a new entry in `model_list` and set the API key in `.env`
- LiteLLM UI is available at `http://localhost:4001/ui` (requires login)
