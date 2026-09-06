#!/usr/bin/env python3
"""Two static servers on different ports, so the fixture can load a stylesheet
that is genuinely cross-origin (the case where CSSOM access throws)."""
import functools, http.server, socketserver, sys, threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # project root


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # nocors.css is deliberately served without CORS so the fixture has a
        # stylesheet that is both unreadable via CSSOM and unfetchable.
        if "nocors" not in self.path:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def serve(port):
    handler = functools.partial(Handler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    threading.Thread(target=serve, args=(8124,), daemon=True).start()
    print("fixture: http://localhost:8123/tools/fixture/index.html?lumen=1", flush=True)
    serve(8123)
