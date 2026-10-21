#!/usr/bin/env python3
# Development server for `make run`: `python3 -m http.server`, except that every
# response says Cache-Control: no-cache, and Range requests are answered (206). The page loads build/cpu-worker.js and
# build/v86.wasm under a fixed ?<version> query, so without this a browser can
# keep running a stale bundle or core after a rebuild. The page is also
# cross-origin isolated (COOP/COEP), which the cores in host threads need
# (index.html with more than one CPU core, src/parallel).
#
# It also starts the local disk service (tools/disk-service.mjs,
# docs/disk-persistence-plan.md) on 127.0.0.1:8471 for the images in
# images/ (V86_DISK_DIR another directory; V86_DISK_SERVICE=0 none), for
# this page's origins only: the page's "read write" hard disks are
# http://127.0.0.1:8471/<name>, written back to <directory>/<name>. The VM
# manager may create new images there (--allow-create, docs/vm-manager-plan.md).
import contextlib
import http.server
import io
import os
import re
import shutil
import socket
import subprocess
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        # Range requests (bytes=<first>-<last>), as web servers answer them:
        # v86 reads images given by URL (async) in parts
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        path = self.translate_path(self.path)
        if not match or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        first = int(match.group(1))
        last = min(int(match.group(2)) if match.group(2) else size - 1, size - 1)
        if first >= size or last < first:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        with open(path, "rb") as f:
            f.seek(first)
            data = f.read(last - first + 1)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        return io.BytesIO(data)


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
disk_service = None
disk_dir = os.environ.get("V86_DISK_DIR", "images")
if os.environ.get("V86_DISK_SERVICE", "1") != "0" and shutil.which("node") and os.path.isdir(disk_dir):
    origins = [f"http://localhost:{port}", f"http://127.0.0.1:{port}", f"http://[::1]:{port}"]
    disk_service = subprocess.Popen(["node", "tools/disk-service.mjs", "--dir", disk_dir, "--port", "8471", "--allow-create"] +
                                    [arg for origin in origins for arg in ("--origin", origin)], stdout=subprocess.DEVNULL)
    print(f"Disk service for {os.path.realpath(disk_dir)} on http://127.0.0.1:8471/ (read write hard disks)", flush=True)
try:
    with server:
        print(f"Serving on http://localhost:{port}/", flush=True)
        server.serve_forever()
finally:
    if disk_service:
        disk_service.terminate()
