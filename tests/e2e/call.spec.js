// End-to-end test (story #20): two browser contexts complete a full call via the
// capability-URL handshake. Verifies UC-1 (host), UC-2 (join), and SM-5 (link join).
import { test, expect } from "@playwright/test";

test("two peers connect end to end via the capability-URL handshake", async ({ browser }) => {
  const ctxHost = await browser.newContext({ permissions: ["camera", "microphone"] });
  const ctxGuest = await browser.newContext({ permissions: ["camera", "microphone"] });
  const host = await ctxHost.newPage();
  const guest = await ctxGuest.newPage();

  // Host: start media, create the invite.
  await host.goto("/");
  await host.click("#startCam");
  await expect(host.locator("#createInvite")).toBeEnabled();
  await host.click("#createInvite");
  await expect(host.locator("#inviteUrl")).not.toHaveValue("", { timeout: 15000 });
  const invite = await host.locator("#inviteUrl").inputValue();
  expect(invite).toContain("#invite=");

  // Guest: open the invite link, start media, produce an answer.
  await guest.goto(invite);
  await guest.click("#startCam");
  await expect(guest.locator("#joinAnswer")).toBeVisible();
  await guest.click("#joinAnswer");
  await expect(guest.locator("#answerUrl")).not.toHaveValue("", { timeout: 15000 });
  const answer = await guest.locator("#answerUrl").inputValue();
  expect(answer).toContain("#answer=");

  // Host: load the answer; the connection establishes.
  await host.fill("#incomingIn", answer);
  await host.click("#loadIncoming");

  // Both sides receive remote media and reach a connected state.
  for (const page of [host, guest]) {
    await expect
      .poll(() => page.evaluate(() => document.getElementById("remoteVideo").srcObject !== null), { timeout: 25000 })
      .toBe(true);
  }
  await expect(host.locator("#status")).toContainText("connected", { timeout: 25000 });

  await ctxHost.close();
  await ctxGuest.close();
});

test("an invalid pasted token is rejected with no state change", async ({ page }) => {
  await page.goto("/");
  await page.fill("#incomingIn", "totally-not-a-valid-token");
  await page.click("#loadIncoming");
  await expect(page.locator("#status")).toContainText("Konnte Eingabe nicht lesen");
  await expect(page.locator("#joinAnswer")).toBeHidden();
});
