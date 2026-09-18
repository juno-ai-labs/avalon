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

it("forwards same-origin cookie requests through the configured regional service without changing proofs", async () => {
  const response = await exports.default.fetch("https://browser.example.test/regional/global/browser/email/redeem", {
    method: "POST", headers: { Origin: "https://browser.example.test", Cookie: "__Host-rally-browser-global=prior", "Content-Type": "application/json" },
    body: JSON.stringify({ proof: "one-use" }),
  });
  expect(await response.json()).toEqual({ url: "https://api.rallywith.ai/browser/email/redeem", method: "POST",
    cookie: "__Host-rally-browser-global=prior", origin: "https://browser.example.test", body: '{"proof":"one-use"}' });
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("cache-control")).toBe("no-store");
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
