# Outbound HTTPS through the sandbox proxy

**Read this whenever an outbound HTTPS request fails in an agent sandbox with an
error that does not look like a network error** — an assertion inside a HTTP
client, an aborted stream, or a bare `403` from something that should not be
returning `403`.

Agent sandboxes route outbound HTTPS through a local CONNECT proxy
(`HTTPS_PROXY`) whose CA is trusted by the image. Two distinct failures come out
of that arrangement, and they need different fixes.

## Diagnose first

The proxy reports its own state, including the last hosts it refused:

```bash
curl -sS "$HTTPS_PROXY/__agentproxy/status"
```

`recentRelayFailures` names the exact host and the reason, which is faster and
more reliable than reading a stack trace. `noProxy` lists the hosts already
dialled directly.

## Failure 1 — the host is not permitted by the network policy

The gateway answers the CONNECT with `403` and every client reports it in its own
dialect:

```
curl: (56) CONNECT tunnel failed, response 403
```
```
✘ [ERROR] Failed to start the remote proxy session.
          Error reloading remote server: Proxy response (403) !== 200 when HTTP Tunneling
```

The second is `wrangler dev` trying to serve the `ai` binding, which has no local
implementation, from Cloudflare's network. Both Workers exit and the healthy
region is torn down with the failed one, so it presents as a total failure to
start rather than as a missing binding. Use `pnpm dev:api:local`, which disables
remote bindings; see
[the development environment guide](dev-environment.md#3-start-the-api-workers).

The general fix is to widen the environment's network policy — the host list is
in [the sandbox environment](SANDBOX.md#network-access). Do not work around a
policy denial by disabling TLS verification or unsetting `HTTPS_PROXY`.

## Failure 2 — the client breaks on the tunnel

The host is permitted, `curl` reaches it, and one specific client still fails.
`undici` — the HTTP client inside Node's `fetch`, wrangler, and Electron's
installer — aborts mid-stream on the CONNECT tunnel with an internal assertion
rather than an error:

```
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  assert(!this.paused)
    at Parser.finish (.../undici/lib/dispatcher/client-h1.js:368:5)
```

This is what a failed `electron` postinstall looks like during `pnpm install`.
The download is 125 MB from `github.com`; `curl` streams the whole thing through
the same proxy without complaint, so the tunnel is not the problem in itself.

The fix is to let that host bypass the proxy and dial directly, which is
CA-trusted and works. For the current shell:

```sh
for host in github.com objects.githubusercontent.com; do   # the host(s) that failed
  case ",$no_proxy," in *",$host,"*) ;; *) export no_proxy="${no_proxy:+$no_proxy,}$host" ;; esac
  case ",$NO_PROXY," in *",$host,"*) ;; *) export NO_PROXY="${NO_PROXY:+$NO_PROXY,}$host" ;; esac
done
```

With those exported, `node install.js` inside
`node_modules/.pnpm/electron@*/node_modules/electron` completes and the binary
lands in `dist/`.

The persistent list lives in `/etc/profile.d/zz-avalon-noproxy.sh`, written by
the environment setup script in [the sandbox environment](SANDBOX.md#setup-script)
and sourced by both login and interactive shells. To make a new host permanent,
add it there and tell whoever maintains the environment; a session export alone
disappears with the container.

### Last resort: install the Electron binary by hand

If the download cannot be repaired, fetch and unpack it directly. The `electron`
package resolves its binary through `path.txt` relative to its own directory, so
this is exactly what the postinstall step would have produced:

```bash
cd node_modules/.pnpm/electron@43.2.0/node_modules/electron
curl -sSL -o /tmp/electron.zip \
  https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-linux-x64.zip
mkdir -p dist && unzip -q -o /tmp/electron.zip -d dist
chmod +x dist/electron && printf electron > path.txt
node -e "console.log(require('electron'))"   # expect the path to dist/electron
```

`printf`, not `echo`: `index.js` reads `path.txt` without trimming and joins the
result onto `dist/`, so a trailing newline makes `existsSync` fail on
`dist/electron\n` and calls `downloadElectron()` — re-running the download this
whole procedure exists to avoid. Verify with `require('electron')` rather than
`./dist/electron --version`, which bypasses that resolution entirely and passes
even when `path.txt` is malformed.

Match the version to the `electron` dependency in `apps/desktop/package.json`.
