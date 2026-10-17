#!/usr/bin/env python3
# Development server for `make run`: `python3 -m http.server`, except that every
# response says Cache-Control: no-cache. The page loads build/cpu-worker.js and
# build/v86.wasm under a fixed ?<version> query, so without this a browser can
# keep running a stale bundle or core after a rebuild. The page is also
# cross-origin isolated (COOP/COEP), which the cores in host threads need
# (index.html with more than one CPU core, src/parallel).
import contextlib
import http.server
import socket
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        # Dual stack, like http.server's own command line: localhost may be ::1 or 127.0.0.1.
        with contextlib.suppress(Exception):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
try:
    server = Server(("::", port), Handler)
except OSError as error:
    # (on stdout: `make run` discards stderr, the request log)
    print(f"Port {port}: {error.strerror}. Another dev server (an earlier `make run`?) may serve this directory "
          f"already: open http://localhost:{port}/, or run python3 tools/dev-server.py <port>.", flush=True)
    sys.exit(1)
with server:
    print(f"Serving on http://localhost:{port}/", flush=True)
    server.serve_forever()
