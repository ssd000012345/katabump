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

// --- INJECTED_SCRIPT：支持 Turnstile (iframe) 和 ALTCHA (主 frame) ---
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

// ==================== 核心修复：正确读取 ALTCHA 状态 ====================
/**
 * 正确读取 ALTCHA widget 的当前状态
 * data-state 在 Shadow DOM 内部的 .altcha div 上，不在 <altcha-widget> 元素上
 */
async function getAltchaState(page) {
    return await page.evaluate(() => {
        const widget = document.querySelector('altcha-widget');
        if (!widget) return null;
        // 方法1：ALTCHA 的公开 API getState()
        if (typeof widget.getState === 'function') {
            const s = widget.getState();
            if (s) return s;
        }
        // 方法2：Shadow DOM 内的 .altcha 容器
        const inner = widget.shadowRoot?.querySelector('.altcha');
        if (inner) {
            const state = inner.getAttribute('data-state');
            if (state) return state;
        }
        // 方法3：自定义元素上的 data-state 属性
        const attr = widget.getAttribute('data-state');
        if (attr) return attr;
        return null;
    });
}

/**
 * 检查当前页面是否有 ALTCHA widget
 */
async function hasAltchaWidget(page) {
    return await page.evaluate(() => !!document.querySelector('altcha-widget'));
}

/**
 * 等待 ALTCHA 变为 verified，最多 timeoutSec 秒
 */
async function waitForAltchaVerified(page, timeoutSec = 12) {
    for (let sec = 0; sec < timeoutSec; sec++) {
        const state = await getAltchaState(page);
        if (state === 'verified') {
            console.log('   >> ALTCHA: ✅ verified!');
            return true;
        }
        if (state === 'error') {
            console.log('   >> ALTCHA: ❌ error state.');
            return false;
        }
        await page.waitForTimeout(1000);
    }
    return false;
}
// =====================================================================

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

            console.log(`>> 在 ${isMainFrame ? '主 frame' : 'iframe'} 发现 ${isAltcha ? 'ALTCHA' : 'Turnstile'}。`);

            if (isMainFrame && isAltcha) {
                const viewport = page.viewportSize();
                if (!viewport) continue;
                const clickX = viewport.width * data.xRatio;
                const clickY = viewport.height * data.yRatio;
                console.log(`>> [ALTCHA CDP] 点击 (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 60));
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }

            const iframeElement = await frame.frameElement();
            if (!iframeElement) continue;
            const box = await iframeElement.boundingBox();
            if (!box) continue;

            const clickX = box.x + (box.width * data.xRatio);
            const clickY = box.y + (box.height * data.yRatio);
            console.log(`>> [Turnstile CDP] 点击 (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);

            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            console.log('>> CDP 点击已发送。');
            await client.detach();
            return true;
        } catch (e) {}
    }
    return false;
}

/**
 * ALTCHA 方案一：Playwright 原生点击 .altcha-checkbox（实测最可靠）
 */
async function solveAltchaByClick(page) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            // 先检查是否已经 verified
            const currentState = await getAltchaState(page);
            if (currentState === 'verified') {
                console.log('   >> [点击] ALTCHA 已验证，跳过。');
                return true;
            }

            const checkbox = page.locator('.altcha-checkbox').first();
            if (await checkbox.count() === 0) {
                if (attempt === 0) console.log('   >> [点击] .altcha-checkbox 未找到。');
                await page.waitForTimeout(1000);
                continue;
            }

            const box = await checkbox.boundingBox();
            if (!box || box.width === 0) {
                await page.waitForTimeout(500);
                continue;
            }

            console.log(`   >> [点击] 点击 .altcha-checkbox (${box.x.toFixed(0)}, ${box.y.toFixed(0)})`);
            await checkbox.click({ timeout: 3000 });
            console.log('   >> [点击] 已点击，等待验证...');

            if (await waitForAltchaVerified(page, 10)) return true;
            // 即使 waitForAltchaVerified 返回 false，也不一定失败
            // 重新检查一次状态
            const s = await getAltchaState(page);
            if (s === 'verified' || s === 'verifying') {
                console.log(`   >> [点击] 当前状态: ${s}，继续。`);
                return true;
            }
            return false;
        } catch (e) {
            console.log(`   >> [点击] 错误: ${e.message}`);
        }
        await page.waitForTimeout(500);
    }
    return false;
}

/**
 * ALTCHA 方案二：调用 widget.verify() JS API
 */
async function solveAltchaByAPI(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const currentState = await getAltchaState(page);
            if (currentState === 'verified') {
                console.log('   >> [API] ALTCHA 已验证，跳过。');
                return true;
            }

            const triggered = await page.evaluate(() => {
                const w = document.querySelector('altcha-widget');
                if (w && typeof w.verify === 'function') {
                    w.verify();
                    return true;
                }
                return false;
            });

            if (triggered) {
                console.log('   >> [API] verify() 已调用，等待...');
                if (await waitForAltchaVerified(page, 12)) return true;
            }
            return false;
        } catch (e) {
            console.log(`   >> [API] 错误: ${e.message}`);
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

/**
 * 综合 ALTCHA 解决：点击优先（最可靠）→ API → CDP
 */
async function solveAltcha(page) {
    const present = await hasAltchaWidget(page);
    if (!present) return false;

    console.log('   >> 检测到 ALTCHA widget。');

    // 1. Playwright 点击（实测最可靠）
    if (await solveAltchaByClick(page)) return true;

    // 2. JS API
    console.log('   >> 点击未成功，尝试 API...');
    if (await solveAltchaByAPI(page)) return true;

    // 3. CDP 点击（备选）
    console.log('   >> API 未成功，尝试 CDP...');
    for (let fa = 0; fa < 3; fa++) {
        if (await attemptTurnstileCdp(page)) {
            if (await waitForAltchaVerified(page, 10)) return true;
            break;
        }
        await page.waitForTimeout(1000);
    }

    // 最终检查
    const finalState = await getAltchaState(page);
    if (finalState === 'verified' || finalState === 'verifying') {
        console.log(`   >> 最终状态: ${finalState}，视为成功。`);
        return true;
    }

    return false;
}

/**
 * 等待 Cloudflare Turnstile 显示 Success
 */
async function waitForTurnstileSuccess(page, timeoutSec = 10) {
    for (let sec = 0; sec < timeoutSec; sec++) {
        const frames = page.frames();
        for (const f of frames) {
            if (f.url().includes('cloudflare')) {
                try {
                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                        console.log('   >> Cloudflare Turnstile: Success!');
                        return true;
                    }
                } catch (e) {}
            }
        }
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

                // === 登录前 Captcha ===
                console.log('   >> 检查登录前验证码...');
                const hasAltchaLogin = await hasAltchaWidget(page);
                if (hasAltchaLogin) {
                    console.log('   >> 登录页检测到 ALTCHA。');
                    await solveAltcha(page);
                } else {
                    console.log('   >> 登录页无 ALTCHA，尝试 Turnstile CDP...');
                    for (let fa = 0; fa < 15; fa++) {
                        if (await attemptTurnstileCdp(page)) break;
                        await page.waitForTimeout(1000);
                    }
                    await waitForTurnstileSuccess(page, 10);
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

                    // === 智能验证码处理 ===
                    console.log('正在检查验证码...');
                    const hasAltchaModal = await hasAltchaWidget(page);

                    if (hasAltchaModal) {
                        // ALTCHA 路径（精简版，不再浪费 Turnstile 尝试）
                        console.log('   >> 检测到 ALTCHA，直接解决...');
                        await solveAltcha(page);
                    } else {
                        // Turnstile 路径（登录页/旧版）
                        console.log('   >> 无 ALTCHA，尝试 Turnstile CDP...');
                        for (let fa = 0; fa < 5; fa++) {
                            if (await attemptTurnstileCdp(page)) break;
                            await page.waitForTimeout(1000);
                        }
                        await waitForTurnstileSuccess(page, 10);
                    }

                    console.log('   >> 验证码处理完成，等待 3 秒...');
                    await page.waitForTimeout(3000);

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
