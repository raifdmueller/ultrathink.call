// End-to-end tests (#20, #21, #22, #23): the capability-URL handshake and the
// host-relayed mesh. Drives 2 and 3 browser contexts through real WebRTC.
import { test, expect } from "@playwright/test";

const newPeer = async (browser) => {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  return { ctx, page: await ctx.newPage() };
};

// Host bootstraps one guest: create invite -> guest joins -> host accepts answer.
async function bootstrap(host, guest) {
  await host.click("#createInvite");
  await expect(host.locator("#inviteUrl")).not.toHaveValue("", { timeout: 15000 });
  const invite = await host.locator("#inviteUrl").inputValue();

  await guest.goto(invite);
  await guest.click("#startCam");
  await expect(guest.locator("#joinAnswer")).toBeVisible();
  await guest.click("#joinAnswer");
  await expect(guest.locator("#answerUrl")).not.toHaveValue("", { timeout: 15000 });
  const answer = await guest.locator("#answerUrl").inputValue();

  await host.fill("#incomingIn", answer);
  await host.click("#loadIncoming");
}

const tileHasStream = (page, id) =>
  expect.poll(
    () => page.evaluate((tid) => {
      const v = document.querySelector(`#tile-${tid} video`);
      return !!(v && v.srcObject);
    }, id),
    { timeout: 30000 }
  ).toBe(true);

test("two peers connect via the capability-URL handshake", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: guest } = await newPeer(browser);

  await host.goto("/");
  await host.click("#startCam");
  await bootstrap(host, guest);

  await tileHasStream(host, "p1");    // host sees the guest
  await tileHasStream(guest, "host"); // guest sees the host
});

test("three peers form a full mesh via host-relayed signaling", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: g1 } = await newPeer(browser);
  const { page: g2 } = await newPeer(browser);

  await host.goto("/");
  await host.click("#startCam");

  await bootstrap(host, g1);          // host <-> guest1 (p1)
  await expect(host.locator("#createInvite")).toBeEnabled();
  await bootstrap(host, g2);          // host <-> guest2 (p2)

  // host sees both guests
  await tileHasStream(host, "p1");
  await tileHasStream(host, "p2");
  // the guests connect to each other automatically through the host relay
  await tileHasStream(g1, "p2");
  await tileHasStream(g2, "p1");
  // and both still see the host
  await tileHasStream(g1, "host");
  await tileHasStream(g2, "host");
});

test("the host can kick a guest out of the mesh (#28)", async ({ browser }) => {
  const { page: host } = await newPeer(browser);
  const { page: g1 } = await newPeer(browser);
  const { page: g2 } = await newPeer(browser);

  await host.goto("/");
  await host.click("#startCam");

  await bootstrap(host, g1);          // host <-> guest1 (p1)
  await expect(host.locator("#createInvite")).toBeEnabled();
  await bootstrap(host, g2);          // host <-> guest2 (p2)

  await tileHasStream(host, "p1");
  await tileHasStream(g2, "p1");      // guest2 also sees guest1 via the relay

  // host evicts guest1: its tile disappears for the host and for the other guest.
  await host.locator("#tile-p1").getByRole("button", { name: "Entfernen" }).click();
  await expect(host.locator("#tile-p1")).toHaveCount(0);
  await expect(g2.locator("#tile-p1")).toHaveCount(0, { timeout: 15000 });
});

test("an invalid pasted token is rejected with no state change", async ({ browser }) => {
  const { page } = await newPeer(browser);
  await page.goto("/");
  await page.fill("#incomingIn", "totally-not-a-valid-token");
  await page.click("#loadIncoming");
  await expect(page.locator("#status")).toContainText("Konnte Eingabe nicht lesen");
  await expect(page.locator("#joinAnswer")).toBeHidden();
});
