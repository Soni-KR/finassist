# Finassist

A simple finance assistant with three agents: general questions, financial analysis, and transaction review. Runs locally with Python and Ollama. No API key is needed for local AI.

## Run

1. Install Python 3.10+ and [Ollama](https://ollama.com/download).
2. Start Ollama and download the model once:

```sh
ollama pull qwen2.5:7b
```

3. Open a terminal in this folder and run:

```sh
python app.py
```

4. Open **http://127.0.0.1:8765**. Keep Python and Ollama running.

Try asking: **Summarize financial performance** or **Review transactions**. You can edit the figures or upload a CSV with `id` and `amount` columns. Demo mode also works without Ollama.
