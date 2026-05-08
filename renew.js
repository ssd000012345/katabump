const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const http = require('http');

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = path.join(__dirname, 'ChromeData_Katabump');
const DEBUG_PORT = 9222;
const HEADLESS = false;
// const HTTP_PROXY = ""
// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY; // e.g., http://user:pass@1.2.3.4:8080 or http://1.2.3.4:8080
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[Proxy] Configuration detected: Server=${PROXY_CONFIG.server}, Auth=${PROXY_CONFIG.username ? 'Yes' : 'No'}`);
    } catch (e) {
        console.error('[Proxy] Invalid HTTP_PROXY format. Expected: http://user:pass@host:port or http://host:port');
        process.exit(1);
    }
}

// --- injected.js 核心逻辑 ---
// 同时支持主 frame 中的 ALTCHA Web Component 和 iframe 中的 Turnstile
const INJECTED_SCRIPT = `
(function() {
    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. Shadow DOM Hook — 主 frame 和 iframe 都运行
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    // Turnstile: input[type="checkbox"]
                    let checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    // ALTCHA: .altcha-checkbox (div)
                    let altchaCheckbox = shadowRoot.querySelector('.altcha-checkbox');
                    if (altchaCheckbox) {
                        const rect = altchaCheckbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio, type: 'altcha' };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                    setTimeout(() => observer.disconnect(), 30000);
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[Injected] Error hooking attachShadow:', e);
    }

    // 3. 主 frame：轮询已存在的 altcha-widget（可能在脚本注入前就创建了 Shadow DOM）
    if (window.self === window.top) {
        const detectExistingAltcha = () => {
            const widget = document.querySelector('altcha-widget');
            if (widget && widget.shadowRoot) {
                const checkbox = widget.shadowRoot.querySelector('.altcha-checkbox');
                if (checkbox) {
                    const rect = checkbox.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                        const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                        const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                        window.__turnstile_data = { xRatio, yRatio, type: 'altcha' };
                        return true;
                    }
                }
            }
            return false;
        };

        if (!detectExistingAltcha()) {
            let pollCount = 0;
            const pollInterval = setInterval(() => {
                if (detectExistingAltcha() || pollCount++ > 60) {
                    clearInterval(pollInterval);
                }
            }, 500);
        }
    }
})();
`;

// 辅助函数：检测代理是否可用
async function checkProxy() {
    if (!PROXY_CONFIG) return true;

    console.log('[Proxy] Validating proxy connection...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };

        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }

        await axios.get('https://www.google.com', axiosConfig);
        console.log('[Proxy] Connection successful!');
        return true;
    } catch (error) {
        console.error(`[Proxy] Connection failed: ${error.message}`);
        return false;
    }
}

// 辅助函数：检测端口是否开放
function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

// 辅助函数：启动原生 Chrome
async function launchNativeChrome() {
    console.log('Checking if Chrome is already running on port ' + DEBUG_PORT + '...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome is already open.');
        return;
    }

    console.log('Launching native Chrome...');
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    if (HEADLESS) {
        args.push('--headless=new');
    }

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('Waiting for Chrome to initialize...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome failed to start on port ' + DEBUG_PORT);
        if (!checkPort(DEBUG_PORT)) {
            try { chrome.kill(); } catch (e) { }
        }
        throw new Error('Chrome launch failed');
    }
}

// 从 login.json 读取用户列表
function getUsers() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'login.json'), 'utf8');
        const json = JSON.parse(data);
        return Array.isArray(json) ? json : (json.users || []);
    } catch (e) {
        console.error('Error reading login.json:', e);
        return [];
    }
}

/**
 * CDP 点击 — 支持 iframe (Turnstile) 和主 frame (ALTCHA)
 */
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;

            const isAltcha = (data.type === 'altcha');
            const isMainFrame = (frame === page.mainFrame());

            console.log(`>> Found ${isAltcha ? 'ALTCHA' : 'Turnstile'} in ${isMainFrame ? 'main frame' : 'iframe'}.`);

            // 主 frame ALTCHA：直接基于 viewport 计算
            if (isMainFrame && isAltcha) {
                const viewport = page.viewportSize();
                if (!viewport) continue;
                const clickX = viewport.width * data.xRatio;
                const clickY = viewport.height * data.yRatio;

                console.log(`>> [ALTCHA] Click at (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 60));
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('>> CDP Click sent (ALTCHA main frame).');
                await client.detach();
                return true;
            }

            // iframe Turnstile：通过 iframe bounding box 计算
            const iframeElement = await frame.frameElement();
            if (!iframeElement) continue;
            const box = await iframeElement.boundingBox();
            if (!box) continue;

            const clickX = box.x + (box.width * data.xRatio);
            const clickY = box.y + (box.height * data.yRatio);

            console.log(`>> [Turnstile] Click at (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            console.log('>> CDP Click sent (Turnstile iframe).');
            await client.detach();
            return true;
        } catch (e) {}
    }
    return false;
}

/**
 * ALTCHA 方案一：调用 widget.verify() JS API
 */
async function solveAltchaViaAPI(page) {
    console.log('   >> [ALTCHA API] Trying widget.verify()...');
    for (let attempt = 0; attempt < 30; attempt++) {
        const result = await page.evaluate(() => {
            const widget = document.querySelector('altcha-widget');
            if (!widget) return { status: 'no-widget' };
            const state = widget.getAttribute('data-state');
            if (state === 'verified') return { status: 'already-verified' };
            if (typeof widget.verify === 'function') {
                try { widget.verify(); return { status: 'triggered' }; }
                catch (e) { return { status: 'error', message: e.message }; }
            }
            return { status: 'no-method' };
        });

        if (result.status === 'already-verified') { console.log('   >> [ALTCHA API] Already verified!'); return true; }
        if (result.status === 'triggered') {
            console.log('   >> [ALTCHA API] verify() called. Waiting for PoW...');
            for (let wait = 0; wait < 25; wait++) {
                await page.waitForTimeout(1000);
                const state = await page.evaluate(() => {
                    const w = document.querySelector('altcha-widget');
                    return w ? w.getAttribute('data-state') : null;
                });
                if (state === 'verified') { console.log('   >> [ALTCHA API] ✅ Verified!'); return true; }
                if (state === 'error') { console.log('   >> [ALTCHA API] ❌ Error state.'); return false; }
            }
            console.log('   >> [ALTCHA API] Timeout.'); return false;
        }
        await page.waitForTimeout(1000);
    }
    console.log('   >> [ALTCHA API] Widget not found.');
    return false;
}

/**
 * ALTCHA 方案二：CDP 点击 Shadow DOM 中的 .altcha-checkbox
 */
async function solveAltchaViaCdp(page) {
    console.log('   >> [ALTCHA CDP] Trying CDP click on .altcha-checkbox...');
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const widget = page.locator('altcha-widget').first();
            if (await widget.count() === 0) { await page.waitForTimeout(1000); continue; }
            const state = await widget.getAttribute('data-state');
            if (state === 'verified') { console.log('   >> [ALTCHA CDP] Already verified!'); return true; }

            const checkbox = widget.locator('.altcha-checkbox');
            if (await checkbox.count() === 0) { await page.waitForTimeout(1000); continue; }
            const box = await checkbox.boundingBox();
            if (!box || box.width === 0) { await page.waitForTimeout(1000); continue; }

            const clickX = box.x + box.width / 2;
            const clickY = box.y + box.height / 2;
            console.log(`   >> [ALTCHA CDP] Clicking at (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
            await new Promise(r => setTimeout(r, 50));
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach();

            console.log('   >> [ALTCHA CDP] Click sent. Waiting...');
            for (let wait = 0; wait < 20; wait++) {
                await page.waitForTimeout(1000);
                const ns = await widget.getAttribute('data-state');
                if (ns === 'verified') { console.log('   >> [ALTCHA CDP] ✅ Verified!'); return true; }
                if (ns === 'error') { console.log('   >> [ALTCHA CDP] ❌ Error.'); return false; }
            }
            return false;
        } catch (e) { console.log(`   >> [ALTCHA CDP] Error: ${e.message}`); }
        await page.waitForTimeout(1000);
    }
    return false;
}

/**
 * 综合 ALTCHA：API → CDP 降级
 */
async function solveAltcha(page) {
    if (await solveAltchaViaAPI(page)) return true;
    if (await solveAltchaViaCdp(page)) return true;
    return false;
}

/**
 * 等待验证完成
 */
async function waitForCaptchaVerified(page, timeoutSec = 15) {
    for (let sec = 0; sec < timeoutSec; sec++) {
        const frames = page.frames();
        for (const f of frames) {
            if (f.url().includes('cloudflare')) {
                try { if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) { console.log('   >> Cloudflare: Success!'); return true; } }
                catch (e) {}
            }
        }
        try {
            const state = await page.evaluate(() => {
                const w = document.querySelector('altcha-widget');
                return w ? w.getAttribute('data-state') : null;
            });
            if (state === 'verified') { console.log('   >> ALTCHA: verified!'); return true; }
        } catch (e) {}
        await page.waitForTimeout(1000);
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('No users found in login.json');
        return;
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[Proxy] Aborting due to invalid proxy.');
            process.exit(1);
        }
    }

    await launchNativeChrome();

    console.log(`Connecting to Chrome instance...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('Successfully connected!');
            break;
        } catch (e) {
            console.log(`Connection attempt ${k + 1} failed. Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('Failed to connect. Exiting.');
        return;
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[Proxy] Setting up authentication...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('Injection script added (supports Turnstile + ALTCHA).');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== Processing User ${i + 1}/${users.length}: ${user.username} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            console.log('Checking session state...');
            if (page.url().includes('/auth/login')) {
            } else if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            } else {
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
                if (page.url().includes('dashboard')) {
                    await page.goto('https://dashboard.katabump.com/auth/logout');
                    await page.waitForTimeout(2000);
                    await page.goto('https://dashboard.katabump.com/auth/login');
                }
            }

            console.log('Filling credentials...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // === 登录前 Captcha ===
                console.log('   >> Checking for captcha before login...');
                let captchaSolved = await solveAltcha(page);
                if (!captchaSolved) {
                    console.log('   >> ALTCHA not detected, trying Turnstile CDP...');
                    for (let fa = 0; fa < 15; fa++) {
                        if (await attemptTurnstileCdp(page)) { captchaSolved = true; break; }
                        await page.waitForTimeout(1000);
                    }
                }
                if (captchaSolved) { await waitForCaptchaVerified(page, 15); }

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ Login failed for user ${user.username}`);
                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('Login form interaction error (maybe already logged in?):', e.message);
            }

            // === See 链接 ===
            console.log('Waiting for "See" link... Current URL:', page.url());
            try {
                const seeSelectors = [
                    'a:has-text("See")',
                    'a:has-text("查看")',
                    'a:has-text("编辑")',
                    `a[href*="edit?id=${user.serverId || '266194'}"]`,
                    'a[href*="servers/edit"]',
                    'a[title*="Edit"], a[title*="编辑"]'
                ];

                let clicked = false;
                for (const sel of seeSelectors) {
                    console.log(`Trying selector: ${sel}`);
                    const link = page.locator(sel).first();
                    if (await link.count() > 0) {
                        await link.waitFor({ state: 'visible', timeout: 20000 });
                        await page.waitForTimeout(1500);
                        console.log(`✅ Found with selector: ${sel}`);
                        await link.click({ timeout: 10000 });
                        clicked = true;
                        break;
                    }
                }

                if (!clicked) {
                    console.log('⚠️ All selectors failed, using direct navigation fallback...');
                    const serverId = user.serverId || process.env.KATABUMP_SERVER_ID || '266194';
                    const editUrl = `https://dashboard.katabump.com/servers/edit?id=${serverId}`;
                    console.log(`→ Direct goto: ${editUrl}`);
                    await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 });
                    await page.waitForTimeout(5000);
                }

                const photoDir = path.join(__dirname, 'photo');
                if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                await page.screenshot({ 
                    path: path.join(photoDir, `${user.username}_after_see_${Date.now()}.png`), 
                    fullPage: true 
                });

            } catch (e) {
                console.error('See link handling error:', e.message);
                try {
                    const serverId = user.serverId || process.env.KATABUMP_SERVER_ID || '266194';
                    await page.goto(`https://dashboard.katabump.com/servers/edit?id=${serverId}`, { waitUntil: 'networkidle' });
                    await page.waitForTimeout(4000);
                } catch (fallbackErr) {
                    console.log('Fallback also failed.');
                }
            }

            // === Renew 主循环 ===
            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                console.log(`\n[Attempt ${attempt}/20] Looking for Renew button...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew button clicked. Waiting for modal...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 8000 }); } catch (e) {
                        console.log('Modal did not appear? Retrying...');
                        continue;
                    }

                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) {}

                    // === ALTCHA + Turnstile ===
                    console.log('Checking for ALTCHA / Turnstile...');
                    let captchaSolved = await solveAltcha(page);

                    if (!captchaSolved) {
                        console.log('   >> ALTCHA not found/solved, trying Turnstile CDP...');
                        for (let fa = 0; fa < 15; fa++) {
                            if (await attemptTurnstileCdp(page)) { captchaSolved = true; break; }
                            await page.waitForTimeout(1000);
                        }
                    }

                    if (!captchaSolved) {
                        console.log('   >> CDP failed, trying Playwright locator fallback...');
                        try {
                            const altchaCheckbox = page.locator('.altcha-checkbox').first();
                            if (await altchaCheckbox.count() > 0 && await altchaCheckbox.isVisible({ timeout: 2000 })) {
                                console.log('   >> ✅ .altcha-checkbox found via Playwright, clicking...');
                                await altchaCheckbox.click({ timeout: 5000 });
                                captchaSolved = true;
                                await page.waitForTimeout(3000);
                                await waitForCaptchaVerified(page, 10);
                            }
                        } catch (e) { console.log('   >> Playwright fallback error:', e.message); }
                    }

                    if (captchaSolved) {
                        console.log('   >> Captcha solved. Waiting...');
                        await page.waitForTimeout(5000);
                    }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        const photoDir = path.join(__dirname, 'photo');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const tsScreenshotName = `${user.username}_Turnstile_${attempt}.png`;
                        try {
                            await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                            console.log(`   >> 📸 Snapshot saved: ${tsScreenshotName}`);
                        } catch (e) {}

                        console.log('   >> Clicking Renew confirm button...');
                        await confirmBtn.click();

                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 4000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ Error: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ Cannot renew yet. Next: ${dateStr}`);
                                    renewSuccess = true;
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) {}
                                    break;
                                }
                                await page.waitForTimeout(300);
                            }
                        } catch (e) {}

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            console.log('   >> Error found. Refreshing page to reset captcha...');
                            await page.reload();
                            await page.waitForTimeout(4000);
                            continue;
                        }

                        await page.waitForTimeout(3000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Modal closed. Renew successful!');
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> Modal still open. Retrying...');
                            await page.reload();
                            await page.waitForTimeout(4000);
                            continue;
                        }
                    } else {
                        console.log('   >> Confirm button not found? Refreshing...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('Renew button not found (server may be already renewed).');
                    break;
                }
            }

        } catch (err) {
            console.error(`Error processing user ${user.username}:`, err);
        }

        const photoDir = path.join(__dirname, 'photo');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const screenshotPath = path.join(photoDir, `${user.username}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`Saved screenshot to: ${screenshotPath}`);
        } catch (e) {
            console.log('Failed to take screenshot:', e.message);
        }

        console.log(`Finished User ${user.username}\n`);
    }

    console.log('All users processed.');
    console.log('Closing browser connection.');
    await browser.close();
})();
