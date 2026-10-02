import { describe, it, expect } from "vitest";
import { browserConversationSource, sessionShareUrl, sessionSourceUrlProvider } from "../src/services/session-import";

describe("conversation import sources", () => {
  it("names the conversation a browser URL shows, from its path", () => {
    const id = "4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c";
    expect(browserConversationSource(`https://claude.ai/chat/${id}/?x=1#y`))
      .toEqual({ provider: "claude", sessionId: id, url: `https://claude.ai/chat/${id}` });
    expect(browserConversationSource(`https://chatgpt.com/c/${id.toUpperCase()}`))
      .toEqual({ provider: "chatgpt", sessionId: id, url: `https://chatgpt.com/c/${id}` });
    expect(browserConversationSource(`https://chatgpt.com/share/${id}`)).toMatchObject({ provider: "chatgpt", sessionId: id });
    // A shared Codex task and a Claude Code web session keep their ids' case.
    expect(browserConversationSource("https://chatgpt.com/s/cx_6abef53d71248191a4b8dcde6233784d/"))
      .toEqual({ provider: "chatgpt", sessionId: "cx_6abef53d71248191a4b8dcde6233784d", url: "https://chatgpt.com/s/cx_6abef53d71248191a4b8dcde6233784d" });
    expect(browserConversationSource("https://claude.ai/code/session_01TPsq6orNbtJsDTRQjwKLDs?tab=1"))
      .toEqual({ provider: "claude", sessionId: "session_01TPsq6orNbtJsDTRQjwKLDs", url: "https://claude.ai/code/session_01TPsq6orNbtJsDTRQjwKLDs" });
    for (const url of [`https://claude.ai/c/${id}`, `https://chatgpt.com/chat/${id}`, `http://claude.ai/chat/${id}`,
      "https://chatgpt.com/s/not-a-task", "https://claude.ai/code/session_x/../../evil",
      `https://claude.ai.evil.test/chat/${id}`, "https://claude.ai/new", "not a url"]) {
      expect(() => browserConversationSource(url), url).toThrow("Open a ChatGPT or Claude conversation");
    }
  });
  it("ties a private source URL to the conversation it names", () => {
    const id = "4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c";
    expect(sessionSourceUrlProvider(`https://claude.ai/chat/${id}`, id)).toBe("claude");
    expect(sessionSourceUrlProvider(`https://chatgpt.com/c/${id}`, id)).toBe("chatgpt");
    expect(() => sessionSourceUrlProvider(`https://claude.ai/chat/${id}`, "another-conversation"))
      .toThrow("The sourceUrl names a different conversation than source.sessionId");
    expect(() => sessionSourceUrlProvider(`https://chatgpt.com/chat/${id}`, id)).toThrow("Use a ChatGPT or Claude public share link");
    expect(sessionSourceUrlProvider("https://claude.ai/code/session_01TPsq6orNbtJsDTRQjwKLDs", "session_01TPsq6orNbtJsDTRQjwKLDs")).toBe("claude");
    expect(() => sessionSourceUrlProvider("https://claude.ai/code/session_01TPsq6orNbtJsDTRQjwKLDs", "session_01tpsq6orNbtJsDTRQjwKLDs"))
      .toThrow("The sourceUrl names a different conversation than source.sessionId");
    expect(sessionSourceUrlProvider("https://chatgpt.com/s/cx_6abef53d71248191a4b8dcde6233784d", "cx_6abef53d71248191a4b8dcde6233784d")).toBe("chatgpt");
  });
  it("rejects arbitrary destinations and identifies Code login requirements", () => {
    for (const url of ["https://example.com/share/123", "https://claude.ai.evil.test/share/123", "http://claude.ai/share/123", "https://user:password@claude.ai/share/123"]) expect(() => sessionShareUrl(url)).toThrow();
    expect(() => sessionShareUrl("https://claude.ai/code/session_01As61kVEUr9wNkGSohfNaZb")).toThrow("signed-in");
  });
});
