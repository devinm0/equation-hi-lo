import { chromium, devices } from 'playwright';

async function openTabs() {
    const iPhone = devices['iPhone 12'];
    const iPhonePro = devices['iPhone 15 Pro'];

    const browser = await chromium.launch({ headless: false });

    const contexts = await Promise.all([...Array(10)].map(() =>
      browser.newContext({ ...iPhonePro })
    ));
    const pages = await Promise.all(
      contexts.map(ctx => ctx.newPage())
    );
    await Promise.all(
      pages.map(page => page.goto("http://localhost:8080"))
    );    

    if (!pages[0]) { throw new Error("pages[0] missing"); }
    const hostPage = pages[0];
    await hostPage.click("#createButton");    
    await hostPage.waitForTimeout(2000); // server must create room and send back, before we try to grab the id
    
    // console.log(await hostPage.locator("#roomCodeContainer").innerText());
    // console.log((await hostPage.locator("#roomCodeContainer").innerText()).split(" "));
    // console.log((await hostPage.locator("#roomCodeContainer").innerText()).split(" ")[1]);

    const roomCode = (await hostPage.locator("#roomCodeContainer").innerText()).split(" ")[1];
    // console.log("checking roomCode");
    // console.log(roomCode);

    if (roomCode === undefined) { throw new Error(); }
    // console.log("roomCodeChecked");

    await hostPage.fill("#nameInput", "Host");
    await hostPage.click("#submitNameButton");

    for (const [index, page] of pages.entries()) {
      if (index === 0) continue; // hostPage
      await page.fill("#roomCodeInput", roomCode);
      await page.click("#enterRoomButton");
      await page.fill("#nameInput", index.toString());
      await page.click("#submitNameButton");
    };

    await hostPage.waitForTimeout(2000); // wait for startGameButton to enable (after receiving message that other player joined)
    await hostPage.click("#startButton");
};

openTabs();