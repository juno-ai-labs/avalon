import "../../../tests/isolated-region";
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("serves the private SPA shell with built assets and no setup", async () => {
  const response = await exports.default.fetch("https://browser.example.test/login/email");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await response.text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).not.toContain("/src/client.tsx");
  const source = /src="(\/assets\/[^"]+\.js)"/u.exec(html)?.[1];
  expect(source).toBeDefined();
  const script = await exports.default.fetch(`https://browser.example.test${source}`);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
});

it("serves the push service worker from the root and lets the shell register it", async () => {
  const worker = await exports.default.fetch("https://browser.example.test/sw.js");
  expect(worker.status).toBe(200);
  expect(worker.headers.get("content-type")).toContain("javascript");
  expect(worker.headers.get("cache-control")).toBe("no-cache");
  const shell = await exports.default.fetch("https://browser.example.test/");
  expect(shell.headers.get("content-security-policy")).toContain("worker-src 'self'");
  // The member shell previews live artifacts in a frame on their own domain, and nowhere else.
  expect(shell.headers.get("content-security-policy")).toContain("frame-src https://*.rallyusercontent.com;");
});

it("serves the annotation script an HTML file's opaque preview frame loads", async () => {
  const script = await exports.default.fetch("https://browser.example.test/annotation-frame.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(script.headers.get("cache-control")).toBe("no-cache");
  expect(script.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await script.text()).toContain("rallyAnnotations");
});

it("serves the install manifest the shell links, and every icon its manifest names", async () => {
  const shell = await (await exports.default.fetch("https://browser.example.test/")).text();
  const linked = (rel: string) => new RegExp(`<link rel="${rel}"[^>]*href="([^"]+)"`, "u").exec(shell)?.[1];
  const manifestPath = linked("manifest");
  expect(manifestPath).toBeDefined();
  const manifestResponse = await exports.default.fetch(`https://browser.example.test${manifestPath}`);
  expect(manifestResponse.status).toBe(200);
  const manifest = await manifestResponse.json() as { icons: { src: string }[] };
  const icons = [...manifest.icons.map((icon) => icon.src), linked("apple-touch-icon")];
  expect(icons).toHaveLength(4);
  for (const path of icons) {
    const icon = await exports.default.fetch(`https://browser.example.test${path}`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    await icon.arrayBuffer();
  }
});

it("serves the favicon the shell links from the root", async () => {
  const favicon = await exports.default.fetch("https://browser.example.test/favicon.svg");
  expect(favicon.status).toBe(200);
  expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
});

it("serves the shell for the page a connector authorization returns to, and nothing beside it", async () => {
  const complete = await exports.default.fetch("https://browser.example.test/connections/complete?status=connected&provider=google");
  expect(complete.status).toBe(200);
  expect(complete.headers.get("cache-control")).toBe("no-store");
  expect(await complete.text()).toContain('<div id="root"></div>');
  expect((await exports.default.fetch("https://browser.example.test/connections/other")).status).toBe(404);
});

it("forwards same-origin cookie requests through the configured regional service without changing proofs", async () => {
  const response = await exports.default.fetch("https://browser.example.test/regional/global/browser/email/redeem", {
    method: "POST", headers: { Origin: "https://browser.example.test", Cookie: "__Host-rally-browser-global=prior", "Content-Type": "application/json" },
    body: JSON.stringify({ proof: "one-use" }),
  });
  expect(await response.json()).toEqual({ url: "https://api.rallywith.ai/browser/email/redeem", method: "POST",
    cookie: "__Host-rally-browser-global=prior", origin: "https://browser.example.test", body: '{"proof":"one-use"}' });
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

it("forwards only the target deployment's cookies, never another deployment's session", async () => {
  const response = await exports.default.fetch("https://browser.example.test/regional/global/browser/session", {
    headers: { Authorization: "Bearer ignored",
      Cookie: "__Host-rally-browser-enterprise=other; __Host-rally-browser-global=mine; analytics=1; __Host-rally-browser-global-google-abc=state" },
  });
  expect(await response.json()).toMatchObject({ cookie: "__Host-rally-browser-global=mine; __Host-rally-browser-global-google-abc=state" });
});

it("reaches a deployment only through its own service binding", async () => {
  // `enterprise` is configured for this test but this Worker has no ENTERPRISE_API binding.
  const response = await exports.default.fetch("https://browser.example.test/regional/enterprise/browser/session");
  expect(response.status).toBe(404);
});

it("refuses arbitrary regional hosts and non-browser API surfaces", async () => {
  for (const path of ["/regional/evil/browser/session", "/regional/global/internal/admin", "/regional/global/auth/refresh", "/regional/global/browser/../auth/refresh", "/onboarding"]) {
    expect((await exports.default.fetch(`https://browser.example.test${path}`)).status).toBe(404);
  }
});

it("forwards a ticketed socket upgrade through the regional service without relaying frames in the host", async () => {
  const path = "/socket/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/0";
  const response = await exports.default.fetch(`https://browser.example.test/regional/global${path}`, {
    headers: { Upgrade: "websocket", Origin: "https://browser.example.test",
      Cookie: "browser-secret", Authorization: "Bearer ignored",
      "Sec-WebSocket-Protocol": "rally.ticket.v1, test-ticket-longer-than-twenty" },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("sec-websocket-protocol")).toBe("rally.ticket.v1");
  const socket = response.webSocket!;
  socket.accept();
  try {
    const received = new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
    socket.send("hello");
    expect(JSON.parse(await received)).toEqual({ message: "hello", path, cookie: null, authorization: null,
      origin: "https://browser.example.test", protocols: "rally.ticket.v1, test-ticket-longer-than-twenty" });
  } finally { socket.close(); }
});

it("requires the same browser origin and an upgrade for socket forwarding", async () => {
  const url = "https://browser.example.test/regional/global/socket/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  expect((await exports.default.fetch(url)).status).toBe(404);
  for (const origin of [undefined, "https://elsewhere.example.test"]) {
    expect((await exports.default.fetch(url, { headers: { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) } })).status).toBe(403);
  }
});

it("sandboxes uploaded HTML documents without buffering or changing the resource", async () => {
  const response = await exports.default.fetch("https://browser.example.test/regional/global/browser/api/workspace/resources/document/preview");
  expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toBe("text/html");
  expect(await response.text()).toBe('<script>document.body.textContent="untrusted"</script>');
});
