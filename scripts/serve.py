#!/usr/bin/env python3
"""
serve.py  -  run Craters from Space locally, with a Copernicus relay.

    python3 scripts/serve.py            then open http://localhost:8000
    python3 scripts/serve.py --port 8080

The dashboard gets its satellite images from the Copernicus Data Space Ecosystem (CDSE).
Browsers block the Copernicus login when a web page calls it directly, so this script serves
the site and passes the requests on, logged in with your CDSE OAuth client (the same role the
Cloudflare Worker has on the public site):

    /cdse/ping        -> {"relay": true, "managed": true}
    /cdse/statistics  -> Statistical API  (which scene of a period is clearest)
    /cdse/process     -> Process API      (the image)

Credentials, in this order:
  1. environment variables CDSE_CLIENT_ID and CDSE_CLIENT_SECRET
  2. the file scripts/.cdse-credentials (created on request, never uploaded: see .gitignore)
  3. asked once when the script starts
Create the OAuth client at https://shapps.dataspace.copernicus.eu/dashboard/ -> User settings
-> OAuth clients. The server listens on this computer only (127.0.0.1). Standard library only.
"""
import argparse, getpass, json, os, ssl, sys, threading, time, urllib.error, urllib.parse, urllib.request, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

IDENTITY = os.environ.get("CDSE_IDENTITY", "https://identity.dataspace.copernicus.eu")
SH = os.environ.get("CDSE_SH", "https://sh.dataspace.copernicus.eu")
TOKEN_URL = IDENTITY + "/auth/realms/CDSE/protocol/openid-connect/token"
ROUTES = {"/cdse/statistics": SH + "/statistics/v1", "/cdse/process": SH + "/process/v1"}
HERE = os.path.dirname(os.path.abspath(__file__))
CRED_FILE = os.path.join(HERE, ".cdse-credentials")

def ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()
CTX = ssl_context()
CERT_HELP = ("Python could not verify Copernicus' HTTPS certificate (common with python.org builds on macOS). "
             f'Fix once: run "/Applications/Python {sys.version_info.major}.{sys.version_info.minor}/Install Certificates.command" '
             "or: python3 -m pip install certifi - then restart serve.py.")

# ---------------------------------------------------------------- credentials
def load_credentials(ask=True):
    cid, secret = os.environ.get("CDSE_CLIENT_ID"), os.environ.get("CDSE_CLIENT_SECRET")
    if cid and secret:
        return cid.strip(), secret.strip()
    if os.path.exists(CRED_FILE):
        try:
            with open(CRED_FILE, encoding="utf-8") as f:
                d = json.load(f)
            return d["client_id"], d["client_secret"]
        except (ValueError, KeyError):
            print(f"Could not read {CRED_FILE}; it will be replaced.")
    if not ask:
        return None, None
    print("\nCopernicus Data Space credentials (OAuth client from shapps.dataspace.copernicus.eu):")
    cid = input("  Client ID: ").strip()
    secret = getpass.getpass("  Client secret (not shown): ").strip()
    if cid and secret and input("  Save them in scripts/.cdse-credentials for next time? [y/N] ").strip().lower() == "y":
        with open(CRED_FILE, "w", encoding="utf-8") as f:
            json.dump({"client_id": cid, "client_secret": secret}, f)
        try: os.chmod(CRED_FILE, 0o600)
        except OSError: pass
        print("  Saved. This file is listed in .gitignore and will not be uploaded.")
    return cid, secret

class Token:
    def __init__(self, cid, secret):
        self.cid, self.secret, self.value, self.until, self.lock = cid, secret, None, 0, threading.Lock()
    def get(self, force=False):
        with self.lock:
            if not force and self.value and time.time() < self.until:
                return self.value
            body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": self.cid,
                                           "client_secret": self.secret}).encode()
            req = urllib.request.Request(TOKEN_URL, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
            try:
                with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                    j = json.load(r)
            except urllib.error.HTTPError as e:
                raise RuntimeError(f"Copernicus login failed (HTTP {e.code}). Check the client ID and secret.")
            self.value = j["access_token"]
            self.until = time.time() + max(30, j.get("expires_in", 300) - 60)
            return self.value

TOKEN = None

# ---------------------------------------------------------------- server
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        line = fmt % args
        if "/cdse/" in line:
            sys.stderr.write("  relay  " + line + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _hidden(self):
        """The credentials file, .git and other dot files and the scripts folder are never served."""
        parts = [x for x in urllib.parse.unquote(self.path.split("?")[0]).split("/") if x]
        return any(x.startswith(".") for x in parts) or (parts[:1] == ["scripts"])

    def do_HEAD(self):
        return self._send(404, "text/plain", b"Not found") if self._hidden() else super().do_HEAD()

    def do_GET(self):
        if self.path == "/cdse/ping":
            return self._send(200, "application/json", b'{"relay":true,"managed":true}')
        if self._hidden():
            return self._send(404, "text/plain", b"Not found")
        return super().do_GET()

    def do_POST(self):
        target = ROUTES.get(self.path.split("?")[0])
        if not target:
            return self._send(404, "text/plain", b"Unknown relay path")
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        accept = self.headers.get("Accept") or "*/*"
        for attempt in (0, 1):
            try:
                req = urllib.request.Request(target, data=body, method="POST", headers={
                    "Authorization": "Bearer " + TOKEN.get(force=attempt == 1),
                    "Content-Type": "application/json", "Accept": accept, "User-Agent": "cratersfromspace/1.0"})
                with urllib.request.urlopen(req, timeout=180, context=CTX) as r:
                    return self._send(r.status, r.headers.get("Content-Type", "application/octet-stream"), r.read())
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0:
                    continue                                   # token expired early: log in again once
                return self._send(e.code, e.headers.get("Content-Type", "text/plain"), e.read())
            except RuntimeError as e:
                return self._error(str(e))
            except urllib.error.URLError as e:
                return self._error(CERT_HELP if "CERTIFICATE_VERIFY_FAILED" in str(e) else f"serve.py could not reach Copernicus: {e.reason}")

    def _error(self, msg):
        sys.stderr.write("  relay  " + msg + "\n")
        return self._send(502, "application/json", json.dumps({"relayError": msg}).encode())

    def _send(self, code, ctype, data):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def main():
    global TOKEN
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    a = ap.parse_args()
    root = os.path.dirname(HERE) if os.path.basename(HERE) == "scripts" else HERE   # repository root
    os.chdir(root)
    if not os.path.exists("index.html"):
        sys.exit(f"index.html not found in {root}. Keep serve.py in the scripts/ folder of the repository.")

    cid, secret = load_credentials(ask=sys.stdin.isatty())
    if not (cid and secret):
        sys.exit("No Copernicus credentials. Set CDSE_CLIENT_ID and CDSE_CLIENT_SECRET, or run serve.py in a terminal to enter them.")
    TOKEN = Token(cid, secret)
    try:
        TOKEN.get()
        print("Logged in to the Copernicus Data Space Ecosystem.")
    except RuntimeError as e:
        sys.exit(str(e))
    except urllib.error.URLError as e:
        sys.exit(CERT_HELP if "CERTIFICATE_VERIFY_FAILED" in str(e) else f"Could not reach Copernicus: {e.reason}")

    url = f"http://localhost:{a.port}/"
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError:
        sys.exit(f"Port {a.port} is in use. Try: python3 scripts/serve.py --port {a.port + 1}")
    print(f"Craters from Space running at {url}\nPress Ctrl+C to stop.")
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    main()
