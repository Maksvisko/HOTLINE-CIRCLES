/* Optional real-browser smoke test. Requires playwright-core and an installed Chromium.
   Run with a local server, GAME_URL and CHROMIUM_EXECUTABLE; see docs/TESTING.md. */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_EXECUTABLE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const errors = [], remote = [], base = process.env.GAME_URL || 'http://127.0.0.1:8000/';
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (new URL(r.url()).origin !== new URL(base).origin) remote.push(r.url()); });
        await page.goto(base);
        await page.locator('#startButton').click();
        assert.equal(await page.locator('#levelGrid .level-button').count(), 6);
        assert.equal(await page.locator('#chapterNext, #levelGrid2').count(), 0);
        await page.locator('#levelGrid .level-button').nth(1).click();
        await page.locator('#characterSelect .character-card').first().click();
        await page.waitForFunction(() => gameState === 'playing');
        assert.ok(await page.evaluate(() => {
            const r = canvas.getBoundingClientRect();
            return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        }));
        await page.mouse.move(640, 360);
        assert.ok(await page.evaluate(() => Math.abs(mouse.x - canvas.width / 2) < 2 && Math.abs(mouse.y - canvas.height / 2) < 2));
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => gameState === 'paused');
        await page.locator('#pauseSettingsBtn').click();
        await page.locator('#langEnBtn').click();
        await page.locator('#resolutionSelect').selectOption('1280x720');
        await page.locator('#settingsBackButton').click();
        await page.locator('#pauseResumeBtn').click();
        await page.waitForFunction(() => gameState === 'playing');
        console.log('PASS: real UI, single campaign, scaled aim, pause/settings/language/resume');
        for (const level of [0, 1, 2, 3, 4, 5]) {
            const result = await page.evaluate(level => {
                backToMainMenuFromGame(); selectedCharacter = 'standard'; startGame(level);
                for (let i = 0; i < 3; i++) { update(); draw(); }
                const snapshot = JSON.stringify(obstacles);
                restartLevel();
                return { level: currentLevel, connected: navigation.connected, stable: JSON.stringify(obstacles) === snapshot };
            }, level);
            assert.equal(result.level, level); assert.ok(result.connected && result.stable);
        }
        console.log('PASS: all six levels initialize, render and restart');
        assert.ok(await page.evaluate(() => {
            startGame(1); walls = []; enemies = [createEnemy(300, 150, 'tank', 1)];
            player.x = 150; player.y = 150; player.hp = 10000;
            mouse.x = 600; mouse.y = 150; mouse.worldX = 600; mouse.worldY = 150;
            canShoot = true; shoot();
            for (let i = 0; i < 14; i++) updatePlayerProjectiles();
            draw();
            return enemies[0].hp < enemies[0].maxHP && combatEffects.particles.length > 0 && combatEffects.traces.length > 0;
        }));
        if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
        await page.evaluate(() => { startHardMode(); backToLevelSelect(); });
        assert.equal(await page.evaluate(() => hardMode), false);
        await page.waitForTimeout(150);
        assert.deepEqual(errors, []);
        assert.deepEqual(remote, []);
        console.log('PASS: ballistic impact/trails, HARD-MODE reset, no page errors or external requests');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
