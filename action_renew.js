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

// --- INJECTED_SCRIPT ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self !== window.top) {
        try {
            function getRandomInt(min, max) {
                return Math.floor(Math.random() * (max - min + 1)) + min;
            }
            let screenX = getRandomInt(800, 1200);
            let screenY = getRandomInt(400, 600);
            Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
            Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
        } catch (e) { }

        try {
            const originalAttachShadow = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function(init) {
                const shadowRoot = originalAttachShadow.call(this, init);
                if (shadowRoot) {
                    const checkAndReport = () => {
                        const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                        if (checkbox) {
                            const rect = checkbox.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                                const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                                const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                                window.__turnstile_data = { xRatio, yRatio };
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
                    }
                }
                return shadowRoot;
            };
        } catch (e) {
            console.error('[注入] Hook attachShadow 失败:', e);
        }
        return;
    }

    // 主 frame：轮询 ALTCHA
    const detectAltcha = () => {
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

    if (!detectAltcha()) {
        let pollCount = 0;
        const pollInterval = setInterval(() => {
            if (detectAltcha() || pollCount++ > 120) clearInterval(pollInterval);
        }, 500);
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
        const req = http.get(`http://localhost:${port}/json/version`, (res) => { resolve(true); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--window-size=1280,720',
        '--no-sandbox', '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
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
    } catch (e) { console.error('解析 USERS_JSON 环境变量错误:', e); }
    return [];
}

// ==================== ALTCHA ====================
async function getAltchaState(page) {
    return await page.evaluate(() => {
        const widget = document.querySelector('altcha-widget');
        if (!widget) return null;
        if (typeof widget.getState === 'function') { const s = widget.getState(); if (s) return s; }
        const inner = widget.shadowRoot?.querySelector('.altcha');
        if (inner) { const s = inner.getAttribute('data-state'); if (s) return s; }
        return widget.getAttribute('data-state');
    });
}

async function hasAltchaWidget(page) {
    return await page.evaluate(() => !!document.querySelector('altcha-widget'));
}

async function waitForAltchaVerified(page, timeoutSec = 10) {
    for (let sec = 0; sec < timeoutSec; sec++) {
        const state = await getAltchaState(page);
        if (state === 'verified') { console.log('   >> ALTCHA: ✅ verified!'); return true; }
        if (state === 'error') { console.log('   >> ALTCHA: ❌ error.'); return false; }
        await page.waitForTimeout(1000);
    }
    return false;
}

// ==================== CDP 点击（修复：Turnstile 路径加了 mouseMoved） ====================
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;

            // ALTCHA 主 frame
            if (data.type === 'altcha' && frame === page.mainFrame()) {
                const viewport = page.viewportSize();
                if (!viewport) continue;
                const clickX = viewport.width * data.xRatio;
                const clickY = viewport.height * data.yRatio;
                console.log(`>> [ALTCHA CDP] 点击 (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }

            // Turnstile iframe（修复：加了 mouseMoved + 随机延迟）
            const iframeElement = await frame.frameElement();
            if (!iframeElement) continue;
            const box = await iframeElement.boundingBox();
            if (!box) continue;

            const clickX = box.x + (box.width * data.xRatio);
            const clickY = box.y + (box.height * data.yRatio);
            console.log(`>> [Turnstile] 点击 (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);

            const client = await page.context().newCDPSession(page);
            // 先移动鼠标到目标位置（模拟真人）
            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
            await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            console.log('>> CDP 点击已发送。');
            await client.detach();
            return true;
        } catch (e) {}
    }
    return false;
}

// ==================== ALTCHA 解决 ====================
async function solveAltchaByClick(page) {
    for (let a = 0; a < 5; a++) {
        try {
            if ((await getAltchaState(page)) === 'verified') return true;
            const cb = page.locator('.altcha-checkbox').first();
            if (await cb.count() === 0) { await page.waitForTimeout(1000); continue; }
            const box = await cb.boundingBox();
            if (!box || box.width === 0) { await page.waitForTimeout(500); continue; }
            console.log('   >> [点击] 点击 .altcha-checkbox');
            await cb.click({ timeout: 3000 });
            if (await waitForAltchaVerified(page, 10)) return true;
            const s = await getAltchaState(page);
            if (s === 'verified' || s === 'verifying') return true;
            return false;
        } catch (e) { console.log('   >> [点击] 错误:', e.message); }
        await page.waitForTimeout(500);
    }
    return false;
}

async function solveAltchaByAPI(page) {
    for (let a = 0; a < 3; a++) {
        try {
            if ((await getAltchaState(page)) === 'verified') return true;
            const ok = await page.evaluate(() => {
                const w = document.querySelector('altcha-widget');
                if (w && typeof w.verify === 'function') { w.verify(); return true; }
                return false;
            });
            if (ok) { console.log('   >> [API] verify() 已调用。'); if (await waitForAltchaVerified(page, 10)) return true; }
            return false;
        } catch (e) { console.log('   >> [API] 错误:', e.message); }
        await page.waitForTimeout(1000);
    }
    return false;
}

async function solveAltcha(page) {
    if (!(await hasAltchaWidget(page))) return false;
    console.log('   >> 检测到 ALTCHA widget。');
    if (await solveAltchaByClick(page)) return true;
    console.log('   >> 点击未成功，尝试 API...');
    if (await solveAltchaByAPI(page)) return true;
    console.log('   >> API 未成功，尝试 CDP...');
    for (let fa = 0; fa < 3; fa++) {
        if (await attemptTurnstileCdp(page)) { if (await waitForAltchaVerified(page, 10)) return true; break; }
        await page.waitForTimeout(1000);
    }
    const fs = await getAltchaState(page);
    return fs === 'verified' || fs === 'verifying';
}

async function waitForTurnstileSuccess(page, timeoutSec = 12) {
    for (let sec = 0; sec < timeoutSec; sec++) {
        const frames = page.frames();
        for (const f of frames) {
            if (f.url().includes('cloudflare')) {
                try { if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) { console.log('   >> Cloudflare: Success!'); return true; } }
                catch (e) {}
            }
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

async function navigateToServerEdit(page, user) {
    console.log('正在定位服务器编辑页...');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    if (!page.url().includes('dashboard')) { console.log('   >> ⚠️ 不在 dashboard，跳过。'); return false; }

    let editUrl = null;
    try {
        editUrl = await page.evaluate(() => {
            const links = document.querySelectorAll('a[href*="servers/edit"]');
            for (const l of links) { if (l.offsetParent !== null) return l.href; }
            const all = document.querySelectorAll('a');
            for (const l of all) { if (l.textContent.trim() === 'See' && l.offsetParent !== null) return l.href; }
            for (const l of all) { const t = l.textContent.trim(); if ((t === '查看' || t === '编辑') && l.offsetParent !== null) return l.href; }
            return null;
        });
    } catch (e) { console.log('   DOM 提取 URL 出错:', e.message); }

    if (editUrl) {
        if (!editUrl.startsWith('http')) editUrl = 'https://dashboard.katabump.com' + (editUrl.startsWith('/') ? '' : '/') + editUrl;
        console.log(`→ ${editUrl}`);
        await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } else {
        const sid = user.serverId || process.env.KATABUMP_SERVER_ID || '266194';
        editUrl = `https://dashboard.katabump.com/servers/edit?id=${sid}`;
        console.log(`→ 兜底: ${editUrl}`);
        await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 });
    }
    await page.waitForTimeout(3000);
    return true;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) { console.log('未在 process.env.USERS_JSON 中找到用户'); process.exit(1); }

    if (PROXY_CONFIG) { if (!(await checkProxy())) { console.error('[代理] 代理无效。'); process.exit(1); } }

    await launchChrome();

    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); console.log('连接成功！'); break; }
        catch (e) { console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`); await new Promise(r => setTimeout(r, 2000)); }
    }
    if (!browser) { console.error('连接失败。退出。'); process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    } else { await context.setHTTPCredentials(null); }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加（支持 Turnstile + ALTCHA）。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }

            // === 登录（带重试） ===
            let loginSuccess = false;
            for (let la = 1; la <= 3; la++) {
                console.log(`\n[登录尝试 ${la}/3]`);

                if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(2000); }
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
                if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(2000); await page.goto('https://dashboard.katabump.com/auth/login'); }

                console.log('正在输入凭据...');
                try {
                    const emailInput = page.getByRole('textbox', { name: 'Email' });
                    await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                    await emailInput.fill(user.username);
                    const pwdInput = page.getByRole('textbox', { name: 'Password' });
                    await pwdInput.fill(user.password);
                    await page.waitForTimeout(500);

                    console.log('   >> 检查登录前验证码...');
                    const hasAltchaLogin = await hasAltchaWidget(page);
                    if (hasAltchaLogin) {
                        console.log('   >> 登录页检测到 ALTCHA。');
                        await solveAltcha(page);
                    } else {
                        console.log('   >> 登录页无 ALTCHA，尝试 Turnstile CDP...');
                        let cdpOk = false;
                        for (let fa = 0; fa < 15; fa++) {
                            if (await attemptTurnstileCdp(page)) { cdpOk = true; break; }
                            await page.waitForTimeout(1000);
                        }
                        if (cdpOk) {
                            console.log('   >> CDP 点击已发送，等待验证...');
                            await waitForTurnstileSuccess(page, 12);
                        }
                    }

                    await page.getByRole('button', { name: 'Login', exact: true }).click();
                    // 等页面响应
                    await page.waitForTimeout(4000);

                    // 检查 "Please complete captcha"（timeout 加大到 3000）
                    try {
                        const captchaErr = page.getByText('Please complete captcha');
                        if (await captchaErr.isVisible({ timeout: 3000 })) {
                            console.log(`   >> ⚠️ 验证码未通过（尝试 ${la}/3），刷新重试...`);
                            await page.reload();
                            await page.waitForTimeout(2000);
                            continue;
                        }
                    } catch (e) {}

                    // 检查密码错误
                    try {
                        const pwdErr = page.getByText('Incorrect password or no account');
                        if (await pwdErr.isVisible({ timeout: 2000 })) {
                            console.error('   >> ❌ 登录失败: 账号或密码错误');
                            const pd = path.join(process.cwd(), 'screenshots');
                            if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true });
                            const sn = user.username.replace(/[^a-z0-9]/gi, '_');
                            try { await page.screenshot({ path: path.join(pd, `${sn}_login_fail.png`), fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`);
                            loginSuccess = false;
                            break;
                        }
                    } catch (e) {}

                    if (page.url().includes('dashboard')) { loginSuccess = true; console.log('   >> ✅ 登录成功！'); break; }
                    console.log(`   >> 登录状态未知（${page.url()}），重试...`);

                } catch (e) { console.log('登录表单交互错误:', e.message); }
            }

            if (!loginSuccess) { console.log('   >> 登录最终失败，跳过。'); continue; }

            if (!(await navigateToServerEdit(page, user))) { console.log('   >> 导航失败，跳过。'); continue; }

            // === Renew ===
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
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { console.log('模态框未出现？'); continue; }

                    try { const box = await modal.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); } catch (e) {}

                    console.log('正在检查验证码...');
                    if (await hasAltchaWidget(page)) { console.log('   >> 检测到 ALTCHA。'); await solveAltcha(page); }
                    else {
                        console.log('   >> 无 ALTCHA，尝试 Turnstile CDP...');
                        for (let fa = 0; fa < 5; fa++) { if (await attemptTurnstileCdp(page)) break; await page.waitForTimeout(1000); }
                        await waitForTurnstileSuccess(page, 12);
                    }
                    console.log('   >> 验证码处理完成，等待 3 秒...');
                    await page.waitForTimeout(3000);

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {
                        const pd = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true });
                        const su = user.username.replace(/[^a-z0-9]/gi, '_');
                        try { await page.screenshot({ path: path.join(pd, `${su}_modal_${attempt}.png`), fullPage: true }); } catch (e) {}

                        console.log('   >> 点击 Renew 确认按钮...');
                        await confirmBtn.click();

                        try {
                            const t0 = Date.now();
                            while (Date.now() - t0 < 3000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) { console.log('   >> ⚠️ "Please complete the captcha"。'); hasCaptchaError = true; break; }
                                const nl = page.getByText("You can't renew your server yet");
                                if (await nl.isVisible()) {
                                    const text = await nl.innerText();
                                    const m = text.match(/as of\s+(.*?)\s+\(/);
                                    let ds = m ? m[1] : 'Unknown';
                                    console.log(`   >> ⏳ 暂无法续期。下次: ${ds}`);
                                    try { await page.screenshot({ path: path.join(pd, `${su}_skip.png`), fullPage: true }); } catch (e) {}
                                    await sendTelegramMessage(`⏳ *暂无法续期*\n用户: ${user.username}\n下次可用: ${ds}`);
                                    renewSuccess = true;
                                    try { const cb = modal.getByLabel('Close'); if (await cb.isVisible()) await cb.click(); } catch (e) {}
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) {}

                        if (renewSuccess) break;
                        if (hasCaptchaError) { console.log('   >> 发现错误。刷新...'); await page.reload(); await page.waitForTimeout(3000); continue; }

                        await page.waitForTimeout(2000);
                        if (!(await modal.isVisible())) {
                            console.log('   >> ✅ 续期成功！');
                            try { await page.screenshot({ path: path.join(pd, `${su}_success.png`), fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}`);
                            renewSuccess = true; break;
                        } else { console.log('   >> 模态框仍打开？重试...'); await page.reload(); await page.waitForTimeout(3000); continue; }
                    } else { console.log('   >> 确认按钮未找到？刷新...'); await page.reload(); await page.waitForTimeout(3000); continue; }
                } else { console.log('未找到 Renew 按钮。'); break; }
            }
        } catch (err) { console.error('处理用户出错:', err); }

        const pd = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true });
        try { await page.screenshot({ path: path.join(pd, `${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true }); } catch (e) {}
        console.log('用户处理完成\n');
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
