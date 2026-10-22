"""Run: python app.py. Uses only the Python standard library."""
import argparse
import json
import os
import re
import secrets
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from agents import SAMPLE, DEFAULT_MODEL, ai_credentials, ask_ai, live_available, local_models, run_agent

ROOT = Path(__file__).resolve().parent
STATIC = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def __init__(self, address, handler):
        super().__init__(address, handler)
        self.ai_configuration = None  # None uses environment variables; no key is saved to disk.
        self.ai_verified = False
        self.ai_token = secrets.token_urlsafe(32)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not log questions, CSV contents, or API credentials.

    def reply(self, status, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, dict):
            body = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.valid_host():
            return self.reply(403, {"error": "Use the local workspace address."})
        path = urlsplit(self.path).path
        if path == "/api/ai":
            return self.reply(200, self.connection_status())
        if path == "/api/sample":
            return self.reply(200, {"figures": SAMPLE,
                "csv": (ROOT / "data" / "transactions.csv").read_text(encoding="utf-8"),
                "live_available": live_available(self.configuration())})
        if path in STATIC:
            filename = STATIC[path]
            content_type = {".js": "text/javascript", ".css": "text/css", ".html": "text/html"}[Path(filename).suffix]
            return self.reply(200, (ROOT / "static" / filename).read_bytes(), content_type + "; charset=utf-8")
        self.reply(404, {"error": "Not found."})

    def do_POST(self):
        if not self.valid_host():
            return self.reply(403, {"error": "Use the local workspace address."})
        path = urlsplit(self.path).path
        if path not in {"/api/chat", "/api/ai/connect", "/api/ai/disconnect"}:
            return self.reply(404, {"error": "Not found."})
        # This is a local prototype. Restrict requests to the same origin.
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}:
            return self.reply(403, {"error": "Only same-origin requests are accepted."})
        if path.startswith("/api/ai/"):
            token = self.headers.get("X-CSRF-Token", "")
            if not secrets.compare_digest(token, getattr(self.server, "ai_token", "")) or not token:
                return self.reply(403, {"error": "Refresh the page before changing the AI connection."})
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                return self.reply(415, {"error": "Use JSON for AI connection settings."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 100000:
                return self.reply(413, {"error": "Request must be between 1 and 100,000 bytes."})
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Request must be a JSON object.")
            if path == "/api/ai/connect":
                provider = payload.get("provider", "openai")
                if provider not in ("ollama", "openai"):
                    raise ValueError("Choose Local Ollama or OpenAI.")
                key, model = payload.get("api_key", ""), payload.get("model", DEFAULT_MODEL)
                if provider == "openai" and (not isinstance(key, str) or not 10 <= len(key.strip()) <= 512 or any(char.isspace() for char in key.strip()) or not key.strip().isascii()):
                    raise ValueError("Enter a valid OpenAI API key.")
                if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._:/-]{1,100}", model.strip()):
                    raise ValueError("Enter a valid model ID.")
                if provider == "ollama" and model.strip() not in local_models():
                    raise ValueError("Choose a downloaded local model. Start Ollama if the list is empty.")
                candidate = {"provider": provider, "api_key": key.strip() if provider == "openai" else "", "model": model.strip()}
                ask_ai("general", "Reply with only: Connected.", {"purpose": "Connection test"}, candidate)
                self.server.ai_configuration = candidate
                self.server.ai_verified = True
                result = self.connection_status()
            elif path == "/api/ai/disconnect":
                self.server.ai_configuration = {}
                self.server.ai_verified = False
                result = self.connection_status()
            else:
                result = run_agent(payload, self.configuration())
                if payload.get("mode") == "ai":
                    self.server.ai_verified = True
        except (ValueError, UnicodeDecodeError) as error:
            return self.reply(400, {"error": str(error)})
        except RuntimeError as error:
            return self.reply(502, {"error": str(error)})
        self.reply(200, result)

    def configuration(self):
        return getattr(self.server, "ai_configuration", None)

    def connection_status(self):
        credentials = ai_credentials(self.configuration())
        return {"configured": live_available(credentials), "verified": getattr(self.server, "ai_verified", False),
                "model": credentials.get("model") or DEFAULT_MODEL,
                "provider": credentials.get("provider", "openai"), "local_models": local_models(),
                "csrf_token": getattr(self.server, "ai_token", "")}

    def valid_host(self):
        return self.headers.get("Host") in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Finassist local demo")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = LocalServer(("127.0.0.1", args.port), Handler)
    downloaded_models = local_models()
    if downloaded_models:
        server.ai_configuration = {"provider": "ollama", "model": downloaded_models[0]}
        print(f"Local AI: {downloaded_models[0]} (Ollama, no API key)", flush=True)
    print(f"Finassist: http://127.0.0.1:{server.server_port}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
