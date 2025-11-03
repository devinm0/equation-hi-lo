import { chromium, devices } from 'playwright';

async function openTabs() {
    console.log("hello");

    const iPhone = devices['iPhone 12'];
    const iPhonePro = devices['iPhone 15 Pro'];

    const browser = await chromium.launch({ headless: false });

    const context1 = await browser.newContext({
      ...iPhonePro,
    });
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    await page1.goto("http://localhost:8080");
    await page2.goto("http://localhost:8080");

    await page1.click("#createButton");    
    await page1.waitForTimeout(2000); // server must create room and send back, before we try to grab the id
    
    console.log(await page1.locator("#roomCodeContainer").innerText());
    console.log((await page1.locator("#roomCodeContainer").innerText()).split(" "));
    console.log((await page1.locator("#roomCodeContainer").innerText()).split(" ")[1]);

    const roomCode = (await page1.locator("#roomCodeContainer").innerText()).split(" ")[1];
    console.log("checking roomCode");
    console.log(roomCode);

    if (roomCode === undefined) {
      throw new Error();
    }
    console.log("roomCodeChecked");

    await page1.fill("#nameInput", "Host");
    await page1.click("#submitNameButton");

    await page2.fill("#roomCodeInput", roomCode);
    await page2.click("#enterRoomButton");
    await page2.fill("#nameInput", "NotHost");
    await page2.click("#submitNameButton");

    await page1.waitForTimeout(2000); // wait for startGameButton to enable (after receiving message that other player joined)
    await page1.click("#startButton");


};

openTabs();