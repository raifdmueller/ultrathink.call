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
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 15000 });
  const invite = await host.locator("#inviteLink").getAttribute("href");

  await guest.goto(invite);
  await guest.click("#join");
  await expect(guest.locator("#answerCode")).not.toHaveValue("", { timeout: 15000 });
  const answer = await guest.locator("#answerCode").inputValue();

  await host.fill("#answerIn", answer);
  await host.click("#answerLoad");
  await expect(host.locator("#stepInvite")).toBeHidden({ timeout: 15000 }); // answer accepted
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
  await expect(g2.locator("#tile-p1")).toHaveCount(0, { timeout: 15000 });
  await expect(g1.locator("#videos .tile[id]")).toHaveCount(0, { timeout: 15000 });
  await expect(g1.locator("#status")).toContainText("entfernt");
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
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 15000 });

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
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 15000 });

  await expect(host.locator("#mailInvite")).toBeVisible();
  await expect(host.locator("#shareInvite")).toBeHidden();
  await expect(host.locator("#copyInvite")).toBeVisible();
});

test("the invite is shown as a compact link, not a raw URL string (#44)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  await host.goto("/");
  await host.click("#openCall");

  const link = host.locator("#inviteLink");
  await expect(link).toHaveAttribute("href", /#invite=/, { timeout: 15000 });
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
  await expect(host.locator("#inviteLink")).toHaveAttribute("href", /#invite=/, { timeout: 15000 });
  const invite = await host.locator("#inviteLink").getAttribute("href");
  await guest.goto(invite);
  await guest.click("#join");
  await expect(guest.locator("#answerCode")).not.toHaveValue("", { timeout: 15000 });
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

test("an invalid pasted token is rejected with no state change", async ({ browser }) => {
  const { page } = await newPeer(browser);
  await page.goto("/");
  await page.click("#openCall"); // reveals the host answer-paste field
  await page.fill("#answerIn", "totally-not-a-valid-token");
  await page.click("#answerLoad");
  await expect(page.locator("#status")).toContainText("Konnte Eingabe nicht lesen");
});
