// End-to-end tests: the guided-wizard flow, the capability-URL handshake, and the
// host-relayed mesh. Drives 2 and 3 browser contexts through real WebRTC.
import { test, expect } from "@playwright/test";

const newPeer = async (browser) => {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  return { ctx, page: await ctx.newPage() };
};

// Host bootstraps one guest: open call / invite more -> guest joins -> host accepts
// the pasted answer. `first` picks the host's entry button.
async function bootstrap(host, guest, { first = true } = {}) {
  await host.click(first ? "#openCall" : "#inviteMore");
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 20000 });
  const invite = await host.locator("#inviteLink").getAttribute("href");

  await guest.goto(invite);
  await guest.click("#join");
  await expect(guest.locator("#answerCode")).not.toHaveValue("", { timeout: 20000 });
  const answer = await guest.locator("#answerCode").inputValue();

  await host.fill("#answerIn", answer);
  await host.click("#answerLoad");
  await expect(host.locator("#stepInvite")).toBeHidden({ timeout: 20000 }); // answer accepted
}

const tileHasStream = (page, id) =>
  expect.poll(
    () => page.evaluate((tid) => {
      const v = document.querySelector(`#tile-${tid} video`);
      return !!(v && v.srcObject);
    }, id),
    { timeout: 30000 }
  ).toBe(true);

test("the start screen offers one action, no greyed-out controls (#46)", async ({ browser }) => {
  const { page } = await newPeer(browser);
  await page.goto("/");
  await expect(page.locator("#openCall")).toBeVisible();
  await expect(page.locator("#callControls")).toBeHidden(); // controls appear with the call
  await expect(page.locator("#stepInvite")).toBeHidden();
});

test("two peers connect via the capability-URL handshake", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: guest } = await newPeer(browser);

  await host.goto("/");
  await bootstrap(host, guest);

  await tileHasStream(host, "p1");    // host sees the guest
  await tileHasStream(guest, "host"); // guest sees the host
});

test("three peers form a full mesh via host-relayed signaling", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: g1 } = await newPeer(browser);
  const { page: g2 } = await newPeer(browser);

  await host.goto("/");
  await bootstrap(host, g1);                 // host <-> guest1 (p1)
  await bootstrap(host, g2, { first: false }); // host <-> guest2 (p2) via "Weitere einladen"

  await tileHasStream(host, "p1");
  await tileHasStream(host, "p2");
  await tileHasStream(g1, "p2");
  await tileHasStream(g2, "p1");
  await tileHasStream(g1, "host");
  await tileHasStream(g2, "host");
});

test("the host can kick a guest out of the mesh (#28)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: g1 } = await newPeer(browser);
  const { page: g2 } = await newPeer(browser);

  await host.goto("/");
  await bootstrap(host, g1);
  await bootstrap(host, g2, { first: false });

  await tileHasStream(host, "p1");
  await tileHasStream(g2, "p1");
  await tileHasStream(g1, "host");

  await host.locator("#tile-p1").getByRole("button", { name: "Entfernen" }).click();
  await expect(host.locator("#tile-p1")).toHaveCount(0);
  await expect(g2.locator("#tile-p1")).toHaveCount(0, { timeout: 20000 });
  await expect(g1.locator("#videos .tile[id]")).toHaveCount(0, { timeout: 20000 });
  await expect(g1.locator("#status")).toContainText("entfernt");
});

test("a late-joining guest inherits the muted state (#37)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: g1 } = await newPeer(browser);
  const { page: g2 } = await newPeer(browser);

  await host.goto("/");
  await bootstrap(host, g1);                 // p1 connects
  await tileHasStream(host, "p1");
  await host.locator("#tile-p1").getByRole("button", { name: "Stumm" }).click(); // host mutes p1

  await bootstrap(host, g2, { first: false }); // p2 joins AFTER the mute
  await tileHasStream(g2, "p1");               // g2 forms its link to p1

  const g2HearsP1 = () => g2.evaluate(() => {
    const a = document.querySelector("#tile-p1 video")?.srcObject?.getAudioTracks()[0];
    return a ? a.enabled : null;
  });
  // g2 inherited the muted set: p1's incoming audio is disabled for g2.
  await expect.poll(g2HearsP1, { timeout: 15000 }).toBe(false);

  // Unmuting p1 re-enables it for everyone, including the late joiner (idempotent).
  await host.locator("#tile-p1").getByRole("button", { name: "Laut" }).click();
  await expect.poll(g2HearsP1, { timeout: 15000 }).toBe(true);
});

test("background blur is offered only where the platform supports it (#25, fail-closed)", async ({ browser }) => {
  const { page } = await newPeer(browser);
  await page.goto("/");
  await page.click("#openCall"); // starts media → in-call controls appear
  // Headless Chromium with fake media exposes no native backgroundBlur capability,
  // so the toggle must stay disabled — we never offer a blur we cannot deliver.
  await expect(page.locator("#blurToggle")).toBeDisabled();
  await expect(page.locator("#blurToggle")).toHaveAttribute("title", /nicht unterstützt/);
});

test("invite offers exactly one of native-share or mailto, plus copy (#42)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  await host.goto("/");
  await host.click("#openCall");
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 20000 });

  await expect(host.locator("#copyInvite")).toBeVisible();
  const share = await host.locator("#shareInvite").isVisible();
  const mail = await host.locator("#mailInvite").isVisible();
  expect(share).not.toBe(mail);
});

test("without the Web Share API the invite falls back to mailto (#42)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  await host.addInitScript(() => Object.defineProperty(navigator, "share", { value: undefined, configurable: true }));
  await host.goto("/");
  await host.click("#openCall");
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 20000 });

  await expect(host.locator("#mailInvite")).toBeVisible();
  await expect(host.locator("#shareInvite")).toBeHidden();
  await expect(host.locator("#copyInvite")).toBeVisible();
});

test("the invite is shown as a compact link, not a raw URL string (#44)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  await host.goto("/");
  await host.click("#openCall");

  const link = host.locator("#inviteLink");
  await expect(link).toHaveAttribute("href", /#invite=/, { timeout: 20000 });
  await expect(link).toBeVisible();
  const text = await link.textContent();
  expect(text).not.toContain("#invite=");
  expect(text.length).toBeLessThan(40);
});

test("opening an answer link shows the guard, not a broken join (#46)", async ({ browser }) => {
  // Produce a real answer URL, then open it directly (the footgun).
  const { page: host } = await newPeer(browser);
  const { page: guest } = await newPeer(browser);
  await host.goto("/");
  await host.click("#openCall");
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 20000 });
  const invite = await host.locator("#inviteLink").getAttribute("href");
  await guest.goto(invite);
  await guest.click("#join");
  await expect(guest.locator("#answerCode")).not.toHaveValue("", { timeout: 20000 });
  const answer = await guest.locator("#answerCode").inputValue();

  const { page: stray } = await newPeer(browser);
  await stray.goto(answer); // someone opens the answer link
  await expect(stray.locator("#answerGuard")).toBeVisible();
  await expect(stray.locator("#join")).toBeHidden();
  await expect(stray.locator("#guardCode")).not.toHaveValue("");
});

test("self-mute toggles the local mic and camera (#47)", async ({ browser }) => {
  const { page } = await newPeer(browser);
  await page.goto("/");
  await page.click("#openCall"); // media live → in-call controls appear
  await expect(page.locator("#muteMic")).toBeVisible();

  const enabled = (kind) => page.evaluate((k) =>
    document.querySelector("#localVideo").srcObject[k === "audio" ? "getAudioTracks" : "getVideoTracks"]()[0].enabled, kind);

  await page.click("#muteMic");
  expect(await enabled("audio")).toBe(false);
  await expect(page.locator("#muteMic")).toHaveText("Mikro an");
  await expect(page.locator("#localMicFlag")).toBeVisible();
  await page.click("#muteMic");
  expect(await enabled("audio")).toBe(true);
  await expect(page.locator("#localMicFlag")).toBeHidden();

  await page.click("#muteCam");
  expect(await enabled("video")).toBe(false);
  await expect(page.locator("#muteCam")).toHaveText("Kamera an");
  await expect(page.locator("#localCamFlag")).toBeVisible();

  // A device switch acquires a fresh track (enabled by default) — the mute must
  // survive it (#47 re-apply path).
  await page.evaluate(() => document.getElementById("camSelect").dispatchEvent(new Event("change")));
  await expect(page.locator("#status")).toHaveText("Gerät gewechselt.", { timeout: 10000 });
  expect(await enabled("video")).toBe(false);
});

test("in-call chat broadcasts over the data channel (#48)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: guest } = await newPeer(browser);
  await host.goto("/");
  await bootstrap(host, guest);
  await tileHasStream(host, "p1"); // connected

  await host.fill("#chatInput", "hallo welt");
  await host.click("#chatSend");
  await expect(guest.locator("#chatLog")).toContainText("Host: hallo welt", { timeout: 10000 });
  await expect(host.locator("#chatLog")).toContainText("Du: hallo welt"); // own echo
});

test("chat renders messages as text, never HTML (#48, BR-8)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: guest } = await newPeer(browser);
  await host.goto("/");
  await bootstrap(host, guest);
  await tileHasStream(host, "p1");

  await host.fill("#chatInput", "<img src=x onerror=oops>");
  await host.click("#chatSend");
  await expect(guest.locator("#chatLog")).toContainText("<img src=x onerror=oops>", { timeout: 10000 });
  expect(await guest.locator("#chatLog img").count()).toBe(0); // never interpreted as HTML
});

test("opening the answer link auto-applies it via the call tab (#65)", async ({ browser }) => {
  const hostCtx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const host = await hostCtx.newPage();
  const { page: guest } = await newPeer(browser);

  await host.goto("/");
  await host.click("#openCall");
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 20000 });
  const invite = await host.locator("#inviteLink").getAttribute("href");
  await guest.goto(invite);
  await guest.click("#join");
  await expect(guest.locator("#answerCode")).not.toHaveValue("", { timeout: 20000 });
  const answer = await guest.locator("#answerCode").inputValue();

  // The host "clicks" the answer: open it in a SECOND tab of the same browser.
  const helper = await hostCtx.newPage();
  await helper.goto(answer);

  // The call tab applies it automatically — no manual paste.
  await tileHasStream(host, "p1");
  await expect(helper.locator("#answerDone")).toBeVisible({ timeout: 10000 });
  await hostCtx.close();
});

test("the invite copies as a rich HTML link plus a plain-text fallback (#60)", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.click("#openCall");
  await expect(page.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 20000 });

  await page.click("#copyInvite");
  await expect(page.locator("#status")).toContainText("Als Link kopiert");

  const { html, plain } = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    let html = "", plain = "";
    for (const it of items) {
      if (it.types.includes("text/html")) html = await (await it.getType("text/html")).text();
      if (it.types.includes("text/plain")) plain = await (await it.getType("text/plain")).text();
    }
    return { html, plain };
  });
  expect(html).toMatch(/<a href="[^"]*#invite=[^"]*">ultrathink\.call-Einladung<\/a>/); // compact link
  expect(plain).toContain("#invite="); // full URL fallback
  await ctx.close();
});

test("sharing the screen keeps the cameras and shows the screen large below them (#67)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: guest } = await newPeer(browser);
  await host.goto("/");
  await bootstrap(host, guest);
  await tileHasStream(host, "p1");
  await tileHasStream(guest, "host");

  host.on("dialog", (d) => d.accept()); // accept the oversharing confirm()
  await host.click("#shareScreen");

  // The guest sees the shared screen big, below the camera row...
  await expect(guest.locator("#sharedScreen")).toBeVisible({ timeout: 20000 });
  await expect.poll(
    () => guest.evaluate(() => !!document.querySelector("#screenVideo")?.srcObject),
    { timeout: 20000 }
  ).toBe(true);
  await expect(guest.locator("#screenLabel")).toContainText("teilt den Bildschirm");
  // ...while the host's camera tile (the guest's view of the host) keeps streaming
  // and the call stays connected — no renegotiation tore it down.
  await tileHasStream(guest, "host");
  await tileHasStream(host, "p1");

  await host.click("#stopShare");
  await expect(guest.locator("#sharedScreen")).toBeHidden({ timeout: 20000 });
});

test("being kicked while sharing tears the screen share down (#67)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: guest } = await newPeer(browser);
  await host.goto("/");
  await bootstrap(host, guest);
  await tileHasStream(host, "p1");

  guest.on("dialog", (d) => d.accept());
  await guest.click("#shareScreen");
  await expect(guest.locator("#stopShare")).toBeVisible({ timeout: 20000 });
  await expect(host.locator("#sharedScreen")).toBeVisible({ timeout: 20000 }); // host sees the guest's screen

  // Host kicks the sharing guest: the guest's local share must be torn down
  // (capture stopped, controls reset) and the host's screen area cleared.
  await host.locator("#tile-p1").getByRole("button", { name: "Entfernen" }).click();
  await expect(guest.locator("#status")).toContainText("entfernt", { timeout: 20000 });
  await expect(guest.locator("#stopShare")).toBeHidden();
  await expect(guest.locator("#shareScreen")).toBeEnabled();
  await expect(guest.locator("#sharedScreen")).toBeHidden();
  await expect(host.locator("#sharedScreen")).toBeHidden({ timeout: 20000 });
});

test("an invalid pasted token is rejected with no state change", async ({ browser }) => {
  const { page } = await newPeer(browser);
  await page.goto("/");
  await page.click("#openCall"); // reveals the host answer-paste field
  await page.fill("#answerIn", "totally-not-a-valid-token");
  await page.click("#answerLoad");
  await expect(page.locator("#status")).toContainText("Konnte Eingabe nicht lesen");
});
