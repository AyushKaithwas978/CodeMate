from fastapi import FastAPI, Request
import requests
import uvicorn

app = FastAPI()

# 1. CHANGE THE MODEL NAME
MODEL = "qwen2.5-coder:1.5b"
OLLAMA_URL = "http://localhost:11434/api/generate"

@app.post("/complete")
async def complete_code(request: Request):
    data = await request.json()

    prefix = data.get("prefix", "")
    suffix = data.get("suffix", "")

    print(f"Incoming Request! Prefix: {prefix[-30:]!r}")

    # 2. SIMPLE PAYLOAD (DeepSeek Base works great with the default 'suffix' param)
    payload = {
        "model": MODEL,
        "system": "You are a code completion engine. Return only the code continuation. Do not explain. Do not add markdown.",
        "prompt": prefix,
        "suffix": suffix,
        "stream": False,
        "options": {
            "temperature": 0.1,  # Keep it precise
            "num_predict": 128,  # Allow it to write full functions
            "stop": ["<|EOT|>", "\n\n\n", "```"] # Stop if it tries to write too much
        }
    }

    try:
        response = requests.post(OLLAMA_URL, json=payload)
        result = response.json().get("response", "")

        # 3. SAFETY CHECK (Just in case)
        # If the model tries to repeat the prompt, clean it.
        if result.startswith(prefix):
            result = result[len(prefix):]

        # If it starts with an explanation or markdown, drop it.
        if "```" in result:
            result = result.split("```", 1)[0]

        print(f"? Code: {result}")
        return {"prediction": result}

    except Exception as e:
        print(f"Error: {e}")
        return {"prediction": ""}

if __name__ == "__main__":
    print("?? DeepSeek-Coder Server running on Port 5000...")
    uvicorn.run(app, host="127.0.0.1", port=5000)


