const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
}

// --- INJECTED_SCRIPT：同时支持 Turnstile (iframe) 和 ALTCHA (主 frame) ---
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
        console.error('[注入] Hook attachShadow 失败:', e);
    }

    // 3. 主 frame：轮询已存在的 altcha-widget
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

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
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
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data'
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    args.push('--disable-dev-shm-usage');

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        throw new Error('Chrome 启动失败');
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
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

            console.log(`>> 在 ${isMainFrame ? '主 frame' : 'iframe'} 中发现 ${isAltcha ? 'ALTCHA' : 'Turnstile'}。`);

            // 主 frame ALTCHA
            if (isMainFrame && isAltcha) {
                const viewport = page.viewportSize();
                if (!viewport) continue;
                const clickX = viewport.width * data.xRatio;
                const clickY = viewport.height * data.yRatio;
                console.log(`>> [ALTCHA] 点击坐标: (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 60));
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('>> CDP 点击已发送 (ALTCHA)。');
                await client.detach();
                return true;
            }

            // iframe Turnstile
            const iframeElement = await frame.frameElement();
            if (!iframeElement) continue;
            const box = await iframeElement.boundingBox();
            if (!box) continue;

            const clickX = box.x + (box.width * data.xRatio);
            const clickY = box.y + (box.height * data.yRatio);
            console.log(`>> [Turnstile] 点击坐标: (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            console.log('>> CDP 点击已发送 (Turnstile)。');
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
    console.log('   >> [ALTCHA API] 尝试 widget.verify()...');
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

        if (result.status === 'already-verified') { console.log('   >> [ALTCHA API] 已验证！'); return true; }
        if (result.status === 'triggered') {
            console.log('   >> [ALTCHA API] verify() 已调用。等待 PoW 计算...');
            for (let wait = 0; wait < 25; wait++) {
                await page.waitForTimeout(1000);
                const state = await page.evaluate(() => {
                    const w = document.querySelector('altcha-widget');
                    return w ? w.getAttribute('data-state') : null;
                });
                if (state === 'verified') { console.log('   >> [ALTCHA API] ✅ 验证成功！'); return true; }
                if (state === 'error') { console.log('   >> [ALTCHA API] ❌ 错误状态。'); return false; }
            }
            console.log('   >> [ALTCHA API] 超时。'); return false;
        }
        await page.waitForTimeout(1000);
    }
    console.log('   >> [ALTCHA API] 未找到 widget。');
    return false;
}

/**
 * ALTCHA 方案二：CDP 点击 Shadow DOM 中的 .altcha-checkbox
 */
async function solveAltchaViaCdp(page) {
    console.log('   >> [ALTCHA CDP] 尝试 CDP 点击 .altcha-checkbox...');
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const widget = page.locator('altcha-widget').first();
            if (await widget.count() === 0) { await page.waitForTimeout(1000); continue; }
            const state = await widget.getAttribute('data-state');
            if (state === 'verified') { console.log('   >> [ALTCHA CDP] 已验证！'); return true; }

            const checkbox = widget.locator('.altcha-checkbox');
            if (await checkbox.count() === 0) { await page.waitForTimeout(1000); continue; }
            const box = await checkbox.boundingBox();
            if (!box || box.width === 0) { await page.waitForTimeout(1000); continue; }

            const clickX = box.x + box.width / 2;
            const clickY = box.y + box.height / 2;
            console.log(`   >> [ALTCHA CDP] 点击 (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
            await new Promise(r => setTimeout(r, 50));
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach();

            console.log('   >> [ALTCHA CDP] 点击已发送。等待验证...');
            for (let wait = 0; wait < 20; wait++) {
                await page.waitForTimeout(1000);
                const ns = await widget.getAttribute('data-state');
                if (ns === 'verified') { console.log('   >> [ALTCHA CDP] ✅ 验证成功！'); return true; }
                if (ns === 'error') { console.log('   >> [ALTCHA CDP] ❌ 错误。'); return false; }
            }
            return false;
        } catch (e) { console.log(`   >> [ALTCHA CDP] 错误: ${e.message}`); }
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
 * 等待验证完成（Turnstile Success 或 ALTCHA verified）
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
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加（支持 Turnstile + ALTCHA）。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // === 登录前 Captcha：ALTCHA 优先 ===
                console.log('   >> 正在检查登录前验证码 (ALTCHA + Turnstile)...');
                let captchaSolved = await solveAltcha(page);
                if (!captchaSolved) {
                    console.log('   >> ALTCHA 未检测到，尝试 Turnstile CDP...');
                    for (let fa = 0; fa < 15; fa++) {
                        if (await attemptTurnstileCdp(page)) { captchaSolved = true; break; }
                        await page.waitForTimeout(1000);
                    }
                }
                if (captchaSolved) {
                    console.log('   >> 验证码已处理。等待验证完成...');
                    await waitForCaptchaVerified(page, 15);
                }

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 用户 ${user.username} 账号或密码错误`);
                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
                        const failShotPath = path.join(photoDir, `${safeUsername}.png`);
                        try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) {}
                        await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);
                        continue;
                    }
                } catch (e) {}

            } catch (e) {
                console.log('登录错误:', e.message);
            }

            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 "See" 按钮。');
                continue;
            }

            // === Renew 主循环 ===
            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) {}

                    // === ALTCHA + Turnstile ===
                    console.log('正在检查验证码 (ALTCHA + Turnstile)...');
                    let captchaSolved = await solveAltcha(page);

                    if (!captchaSolved) {
                        console.log('   >> ALTCHA 未检测到/未解决，尝试 Turnstile CDP...');
                        for (let fa = 0; fa < 15; fa++) {
                            if (await attemptTurnstileCdp(page)) { captchaSolved = true; break; }
                            console.log(`   >> [寻找尝试 ${fa + 1}/15]...`);
                            await page.waitForTimeout(1000);
                        }
                    }

                    if (!captchaSolved) {
                        console.log('   >> CDP 失败，尝试 Playwright locator 兜底...');
                        try {
                            const altchaCheckbox = page.locator('.altcha-checkbox').first();
                            if (await altchaCheckbox.count() > 0 && await altchaCheckbox.isVisible({ timeout: 2000 })) {
                                console.log('   >> ✅ .altcha-checkbox 找到，点击中...');
                                await altchaCheckbox.click({ timeout: 5000 });
                                captchaSolved = true;
                                await page.waitForTimeout(3000);
                                await waitForCaptchaVerified(page, 10);
                            }
                        } catch (e) { console.log('   >> Playwright 兜底错误:', e.message); }
                    }

                    if (captchaSolved) {
                        console.log('   >> 验证码已解决。等待...');
                        await page.waitForTimeout(5000);
                    }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                        const tsScreenshotName = `${safeUser}_Turnstile_${attempt}.png`;
                        try {
                            await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                            console.log(`   >> 📸 快照已保存: ${tsScreenshotName}`);
                        } catch (e) {}

                        console.log('   >> 点击 Renew 确认按钮...');
                        await confirmBtn.click();

                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha"。');
                                    hasCaptchaError = true;
                                    break;
                                }

                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    const skipShotPath = path.join(photoDir, `${safeUser}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) {}
                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n原因: 还没到时间\n下次可用: ${dateStr}`, skipShotPath);

                                    renewSuccess = true;
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) {}
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) {}

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            console.log('   >> 发现错误。刷新页面重置验证码...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }

                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ 模态框关闭。续期成功！');

                            const successShotPath = path.join(photoDir, `${safeUser}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试中...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的确认按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('未找到 Renew 按钮（服务器可能已续期或页面加载错误）。');
                    break;
                }
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        const screenshotPath = path.join(photoDir, `${safeUsername}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
