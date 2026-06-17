# Model Providers

DeepReef supports multiple provider families. Use `/model` to select built-in presets or configure an OpenAI-compatible endpoint.

## Provider matrix

- DeepSeek: deepseek-v4-flash-free, deepseek-v4-flash, deepseek-v4-pro. Users can add their own API key.
- Mimo: mimo-v2.5-free, mimo-v2.5-pro, mimo-v2.5. Users can add their own API key.
- Qwen: Qwen3.6-35B-A3B-MTP through vLLM, Ollama, llama.cpp, or OpenAI-compatible endpoints.
- Gemma: gemma-4-26B-A4B-it-NVFP4 through vLLM, Ollama, llama.cpp, or OpenAI-compatible endpoints.
- Kimi: Kimi-k2.6. Users can add their own API key.
- GLM: GLM-5.1. Users can add their own API key.
- Minimax: Minimax-M3.
- Stepfun: step-3.7-flash-free, step-3.7-flash, step-3.7-turbo. Users can add their own API key.
- NVIDIA: nemotron-3-super-120b-a12b-free, nemotron-3-Omni-free, nemotron-3-Ultra-free. Users can add their own NIM API key.
- Other: Laguna M.1, Laguna SX.2, Nex-N2-Pro, Owl Alpha.
- OpenAI: gpt-oss-120b. Users can add their own API key.
- Custom: any OpenAI-compatible model.

## Thinking modes

`/thinking` supports off, high, and max.

For DeepSeek official API targets, high maps to reasoning_effort=high and max maps to reasoning_effort=max.

Recommended DeepSeek setup:

- Supervisor: deepseek-v4-pro with max thinking.
- Worker: deepseek-v4-flash or deepseek-v4-flash-free with high thinking or off.

DeepSeek V4 targets are configured for a 1,000,000-token context window.
