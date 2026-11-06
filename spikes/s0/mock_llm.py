"""Scripted OpenAI-compatible chat server for exercising DeepCode without a real model.

Behaviour is chosen by a marker in the first user message:
  MARK:TEXT            one short streamed answer
  MARK:SLOW            stream a word every 0.4 s for ~24 s (to test interrupt / kill / restart)
  MARK:WRITE <path>    first model call asks the `write` tool to create <path>; the next call answers "done"
  MARK:JSON            answer with a JSON object only (to test structured plan output)
Every request is appended to the request log so duplicate model calls can be counted.
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2]
PORT = int(sys.argv[1])
LOCK = threading.Lock()


def log(entry):
    with LOCK, open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def text_of(message):
    content = message.get("content")
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content or ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._send_json(200, {"object": "list", "data": [{"id": "mock-1", "object": "model"}]})
        self._send_json(404, {"error": "not found"})

    def _chunk(self, delta, finish=None, usage=None):
        payload = {
            "id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}] if usage is None else [],
        }
        if usage is not None:
            payload["usage"] = usage
        data = f"data: {json.dumps(payload)}\n\n".encode()
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.endswith("/chat/completions"):
            return self._send_json(404, {"error": "not found"})
        messages = body.get("messages", [])
        first_user = next((text_of(m) for m in messages if m.get("role") == "user"), "")
        has_tool_result = any(m.get("role") == "tool" for m in messages)
        marker = first_user.split("MARK:", 1)[1].split()[0] if "MARK:" in first_user else "TEXT"
        log({"t": time.time(), "marker": marker, "messages": len(messages), "tool_result": has_tool_result,
             "tools": len(body.get("tools") or []), "model": body.get("model"), "stream": body.get("stream")})

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        try:
            self._chunk({"role": "assistant", "content": ""})
            if marker == "WRITE" and not has_tool_result:
                path = first_user.split("MARK:WRITE", 1)[1].split()[0]
                self._chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                             "function": {"name": "write", "arguments": json.dumps({"file_path": path, "content": "written by mock\n"})}}]})
                self._chunk({}, finish="tool_calls")
            elif marker == "SLOW":
                for i in range(60):
                    self._chunk({"content": f"word{i} "})
                    time.sleep(0.4)
                self._chunk({}, finish="stop")
            elif marker == "JSON":
                self._chunk({"content": json.dumps({"tasks": [{"id": "t1", "agent": "coder", "input": {"repo": "a"}}]})})
                self._chunk({}, finish="stop")
            else:
                self._chunk({"content": "hello from mock" if marker != "WRITE" else "done"})
                self._chunk({}, finish="stop")
            self._chunk(None, usage={"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110})
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            log({"t": time.time(), "marker": marker, "event": "client_disconnected"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
