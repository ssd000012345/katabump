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
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' });
    } catch (e) {}
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(r => exec(cmd, () => r()));
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
let freeProxyPool = [];
let currentProxy = null;

if (HTTP_PROXY) {
    try {
        const u = new URL(HTTP_PROXY);
        PROXY_CONFIG = { server: `${u.protocol}//${u.hostname}:${u.port}`, username: u.username ? decodeURIComponent(u.username) : undefined, password: u.password ? decodeURIComponent(u.password) : undefined };
        currentProxy = PROXY_CONFIG;
        console.log(`[代理] 预设: ${PROXY_CONFIG.server}`);
    } catch (e) { process.exit(1); }
}

// ==================== 免费代理池 ====================
async function fetchFreeProxies() {
    const sources = [
        { name: 'proxyscrape', url: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all' },
        { name: 'proxylist-download', url: 'https://www.proxy-list.download/api/v1/get?type=http' },
        { name: 'geonode', url: 'https://proxylist.geonode.com/api/proxy-list?limit=10&page=1&sort_by=lastChecked&sort_type=desc&protocols=http' }
    ];

    for (const src of sources) {
        try {
            console.log(`   [代理池] 尝试 ${src.name}...`);
            const res = await axios.get(src.url, { timeout: 15000 });
            let lines = [];

            if (typeof res.data === 'string') {
                lines = res.data.split('\n').filter(l => l.trim() && l.includes(':') && !l.startsWith('#'));
            } else if (Array.isArray(res.data?.data)) {
                lines = res.data.data.map(p => `${p.ip}:${p.port}`);
            }

            const proxies = lines.map(l => {
                const cleaned = l.trim().replace(/\r/g, '');
                return cleaned.startsWith('http') ? cleaned : `http://${cleaned}`;
            }).filter(p => {
                try { const u = new URL(p); return u.hostname && u.port; } catch (e) { return false; }
            });

            if (proxies.length > 0) {
                console.log(`   [代理池] ${src.name}: ${proxies.length} 个`);
                return proxies;
            }
        } catch (e) { console.log(`   [代理池] ${src.name}: ${e.message}`); }
    }
    return [];
}

async function testProxy(proxyUrl) {
    try {
        const u = new URL(proxyUrl);
        await axios.get('https://www.google.com', {
            proxy: { protocol: 'http', host: u.hostname, port: parseInt(u.port) },
            timeout: 8000
        });
        return true;
    } catch (e) { return false; }
}

async function switchToProxy(page, browser) {
    if (freeProxyPool.length === 0) {
        freeProxyPool = await fetchFreeProxies();
    }

    while (freeProxyPool.length > 0) {
        const proxyUrl = freeProxyPool.shift();
        console.log(`   [代理切换] 测试 ${proxyUrl}...`);

        if (!(await testProxy(proxyUrl))) {
            console.log(`   [代理切换] ${proxyUrl} 不可用`);
            continue;
        }

        console.log(`   [代理切换] ✅ ${proxyUrl} 可用，切换中...`);

        // 关闭浏览器
        try { await browser.close(); } catch (e) {}
        try { exec('pkill -f "chrome.*9222"'); } catch (e) {}
        await new Promise(r => setTimeout(r, 3000));

        // 构建新代理配置
        const u = new URL(proxyUrl);
        currentProxy = { server: `${u.protocol}//${u.hostname}:${u.port}` };

        // 重新启动 Chrome
        const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'];
        if (currentProxy) { args.push(`--proxy-server=${currentProxy.server}`); args.push('--proxy-bypass-list=<-loopback>'); }
        spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
        for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }

        // 重连
        browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
        const context = browser.contexts()[0];
        page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        page.setDefaultTimeout(60000);
        if (currentProxy?.username) await context.setHTTPCredentials({ username: currentProxy.username, password: currentProxy.password });
        else await context.setHTTPCredentials(null);
        await page.addInitScript(INJECTED_SCRIPT);

        return { page, browser, ok: true };
    }

    console.log('   [代理切换] 代理池耗尽');
    return { page, browser, ok: false };
}
// ==================================================

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) {
        const da = () => {
            const w = document.querySelector('altcha-widget');
            if (w && w.shadowRoot) {
                const cb = w.shadowRoot.querySelector('.altcha-checkbox');
                if (cb) { const r = cb.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { window.__turnstile_data = { xRatio: (r.left + r.width/2) / window.innerWidth, yRatio: (r.top + r.height/2) / window.innerHeight, type: 'altcha' }; return true; } }
            }
            return false;
        };
        if (!da()) { let c = 0; const iv = setInterval(() => { if (da() || c++ > 120) clearInterval(iv); }, 500); }
        return;
    }
    try { function ri(m,M){return Math.floor(Math.random()*(M-m+1))+m;} Object.defineProperty(MouseEvent.prototype,'screenX',{value:ri(800,1200)}); Object.defineProperty(MouseEvent.prototype,'screenY',{value:ri(400,600)}); } catch(e){}
    try {
        const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(i) {
            const sr = orig.call(this, i);
            if (sr) { const ck = () => { const cb = sr.querySelector('input[type="checkbox"]'); if (cb) { const r = cb.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { window.__turnstile_data = { xRatio: (r.left + r.width/2) / window.innerWidth, yRatio: (r.top + r.height/2) / window.innerHeight }; return true; } } return false; }; if (!ck()) { const ob = new MutationObserver(() => { if (ck()) ob.disconnect(); }); ob.observe(sr, { childList: true, subtree: true }); } }
            return sr;
        };
    } catch(e) {}
})();
`;

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;
            if (data.type === 'altcha' && frame === page.mainFrame()) {
                const vp = page.viewportSize(); if (!vp) continue;
                const cx = vp.width * data.xRatio, cy = vp.height * data.yRatio;
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                await client.detach(); return true;
            }
            const iframeElement = await frame.frameElement();
            if (!iframeElement) continue;
            const box = await iframeElement.boundingBox();
            if (!box) continue;
            const clickX = box.x + (box.width * data.xRatio);
            const clickY = box.y + (box.height * data.yRatio);
            console.log(`>> [Turnstile] 点击 (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach(); return true;
        } catch (e) {}
    }
    return false;
}

async function hasAltchaWidget(page) { return await page.evaluate(() => !!document.querySelector('altcha-widget')); }
async function getAltchaState(page) { return await page.evaluate(() => { const w = document.querySelector('altcha-widget'); if (!w) return null; if (typeof w.getState === 'function') { const s = w.getState(); if (s) return s; } const i = w.shadowRoot?.querySelector('.altcha'); if (i) { const s = i.getAttribute('data-state'); if (s) return s; } return w.getAttribute('data-state'); }); }
async function waitForAltchaVerified(page, t = 15) { for (let s = 0; s < t; s++) { const st = await getAltchaState(page); if (st === 'verified') { console.log('   >> ALTCHA: ✅ verified!'); return true; } if (st === 'error') { console.log('   >> ALTCHA: ❌ error'); return false; } await page.waitForTimeout(1000); } return false; }
async function solveAltchaByClick(page) { for (let a = 0; a < 8; a++) { if ((await getAltchaState(page)) === 'verified') return true; try { const cb = page.locator('.altcha-checkbox').first(); if (await cb.isVisible({ timeout: 2000 })) { await cb.click({ timeout: 3000 }); if (await waitForAltchaVerified(page, 10)) return true; } } catch (e) {} await page.waitForTimeout(800); } return false; }
async function solveAltchaByAPI(page) { try { if ((await getAltchaState(page)) === 'verified') return true; const ok = await page.evaluate(() => { const w = document.querySelector('altcha-widget'); if (w && typeof w.verify === 'function') { w.verify(); return true; } return false; }); if (ok) { console.log('   >> [API] verify() 已调用。'); return await waitForAltchaVerified(page, 12); } } catch (e) {} return false; }
async function solveAltcha(page) { if (!(await hasAltchaWidget(page))) return false; console.log('   >> 检测到 ALTCHA widget。'); if (await solveAltchaByClick(page)) return true; console.log('   >> 点击未成功，尝试 API...'); return await solveAltchaByAPI(page); }

async function findAndClickSeeButton(page) {
    const strategies = [
        () => page.getByRole('link', { name: 'See' }).first(),
        () => page.locator('a[href*="servers/edit"]').first(),
        () => page.locator('a').filter({ hasText: 'See' }).first(),
        () => page.locator('a[aria-label*="See"]').first()
    ];
    for (let i = 0; i < 10; i++) {
        for (const getLocator of strategies) {
            try { const loc = getLocator(); if (await loc.isVisible({ timeout: 1500 })) { await loc.click({ timeout: 5000 }); return true; } } catch (e) {}
        }
        await page.waitForTimeout(1200);
    }
    return false;
}

async function navigateToServerEdit(page, user) {
    const sid = user.serverId || process.env.KATABUMP_SERVER_ID || '266194';
    await page.goto(`https://dashboard.katabump.com/servers/edit?id=${sid}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && Array.isArray(parsed.users)) return parsed.users;
        }
    } catch (e) { return []; }
}

async function checkProxy() { if (!currentProxy) return true; try { const u = new URL(currentProxy.server); const ac = { proxy: { protocol: 'http', host: u.hostname, port: parseInt(u.port) }, timeout: 10000 }; if (currentProxy.username) ac.proxy.auth = { username: currentProxy.username, password: currentProxy.password }; await axios.get('https://www.google.com', ac); return true; } catch (e) { return false; } }
function checkPort(p) { return new Promise(r => { const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); req.on('error', () => r(false)); req.end(); }); }

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'];
    if (currentProxy) { args.push(`--proxy-server=${currentProxy.server}`); args.push('--proxy-bypass-list=<-loopback>'); }
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
    if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome 启动失败');
}

(async () => {
    const users = getUsers();
    if (users.length === 0) { console.log('未找到用户'); process.exit(1); }
    if (currentProxy && !(await checkProxy())) { console.error('代理无效'); process.exit(1); }

    // 预取免费代理池
    if (!currentProxy) {
        console.log('无预设代理，预取免费代理池...');
        freeProxyPool = await fetchFreeProxies();
        console.log(`代理池: ${freeProxyPool.length} 个`);
    }

    await launchChrome();
    let browser;
    for (let k = 0; k < 5; k++) { try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); break; } catch { await new Promise(r => setTimeout(r, 2000)); } }
    if (!browser) { process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);
    if (currentProxy?.username) await context.setHTTPCredentials({ username: currentProxy.username, password: currentProxy.password });
    else await context.setHTTPCredentials(null);
    await page.addInitScript(INJECTED_SCRIPT);

    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    let needProxyRetry = []; // 记录需要代理重试的用户索引

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }

            let loginSuccess = false;
            for (let la = 1; la <= 3; la++) {
                console.log(`\n[登录尝试 ${la}/3]${currentProxy ? ' [代理: ' + currentProxy.server + ']' : ' [无代理]'}`);
                if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(1500); }
                await page.goto('https://dashboard.katabump.com/auth/login'); await page.waitForTimeout(2000);
                if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(1500); await page.goto('https://dashboard.katabump.com/auth/login'); await page.waitForTimeout(2000); }

                console.log('正在输入凭据...');
                try {
                    const emailInput = page.getByRole('textbox', { name: 'Email' });
                    await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                    await emailInput.fill(user.username);
                    await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
                    await page.waitForTimeout(500);

                    if (await hasAltchaWidget(page)) { await solveAltcha(page); }
                    else {
                        let clicked = false;
                        for (let t = 0; t < 18; t++) { if (await attemptTurnstileCdp(page)) { clicked = true; break; } await page.waitForTimeout(800); }
                        if (!clicked) { console.log(`   >> ⚠️ CDP 未点击到（${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; }
                        await page.waitForTimeout(2500);
                    }

                    await page.getByRole('button', { name: 'Login', exact: true }).click();
                    await page.waitForTimeout(3500);

                    if (await page.getByText('Please complete captcha').isVisible({ timeout: 3000 }).catch(() => false)) {
                        console.log(`   >> ⚠️ 验证码未通过（${la}/3）`);
                        await page.reload(); await page.waitForTimeout(2000); continue;
                    }
                    if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 3000 }).catch(() => false)) {
                        console.error('   >> ❌ 密码错误');
                        const failPath = path.join(shotDir, `${safeUser}_login_fail.png`);
                        try { await page.screenshot({ path: failPath, fullPage: true }); } catch (e) {}
                        await sendTelegramMessage(`❌ *登录失败*\n用户${i + 1}: 密码错误`, failPath);
                        loginSuccess = false; break;
                    }
                    if (page.url().includes('dashboard')) { loginSuccess = true; console.log('   >> ✅ 登录成功！'); break; }
                    if (page.url().includes('login') || page.url().includes('auth')) { console.log(`   >> 仍在登录页（${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; }
                    console.log(`   >> 状态未知（${page.url()}）`); await page.reload(); await page.waitForTimeout(2000);
                } catch (e) { console.log('登录错误:', e.message); }
            }

            // 无代理模式登录失败 → 记录，等代理切换后重试
            if (!loginSuccess && !currentProxy) {
                needProxyRetry.push(i);
                console.log('   >> 无代理失败，稍后切换代理重试...');
                continue;
            }
            if (!loginSuccess) { console.log('   >> 登录最终失败，跳过。'); continue; }

            // See 按钮
            const seeOk = await findAndClickSeeButton(page);
            if (!seeOk) { console.log('   >> See 未找到，兜底导航...'); await navigateToServerEdit(page, user); }

            // Renew
            for (let attempt = 1; attempt <= 20; attempt++) {
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { continue; }
                    try { const box = await modal.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); } catch (e) {}

                    if (await hasAltchaWidget(page)) { await solveAltcha(page); }
                    else { let clicked = false; for (let t = 0; t < 25; t++) { if (await attemptTurnstileCdp(page)) { clicked = true; break; } await page.waitForTimeout(1000); } if (clicked) await page.waitForTimeout(2500); }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {
                        try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_modal_${attempt}.png`), fullPage: true }); } catch (e) {}
                        await confirmBtn.click(); await page.waitForTimeout(3000);

                        if (await page.getByText('Please complete the captcha to continue').isVisible({ timeout: 2000 }).catch(() => false)) { console.log('   >> ⚠️ captcha 错误'); await page.reload(); await page.waitForTimeout(3000); continue; }
                        const notTimeLoc = page.getByText("You can't renew your server yet");
                        if (await notTimeLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
                            const text = await notTimeLoc.innerText(); const m = text.match(/as of\s+(.*?)\s+\(/); const ds = m ? m[1] : 'Unknown';
                            console.log(`   >> ⏳ 暂无法续期。下次: ${ds}`);
                            try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_skip.png`), fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`⏳ *暂无法续期*\n用户${i + 1}: ${ds}`);
                            try { const cb = modal.getByLabel('Close'); if (await cb.isVisible()) await cb.click(); } catch (e) {}
                            break;
                        }
                        if (!(await modal.isVisible({ timeout: 1000 }).catch(() => false))) {
                            console.log('   >> ✅ 续期成功！');
                            try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_success.png`), fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`✅ *续期成功*\n用户${i + 1}`);
                            break;
                        } else { await page.reload(); await page.waitForTimeout(3000); continue; }
                    } else { await page.reload(); await page.waitForTimeout(3000); continue; }
                } else { console.log('未找到 Renew 按钮。'); break; }
            }
        } catch (err) { console.error('出错:', err.message); }
        try { await page.screenshot({ path: path.join(shotDir, `${safeUser}.png`), fullPage: true }); } catch (e) {}
        console.log(`用户${i + 1}完成\n`);
    }

    // ==================== 代理重试 ====================
    if (needProxyRetry.length > 0) {
        console.log(`\n===== ${needProxyRetry.length} 个用户需要代理重试 =====`);
        await sendTelegramMessage(`🔄 *切换代理重试*\n无代理失败 ${needProxyRetry.length} 个用户，切换代理中...`);

        const result = await switchToProxy(page, browser);
        if (!result.ok) {
            console.log('代理切换失败');
            await sendTelegramMessage('❌ *代理切换失败*，免费代理池耗尽');
        } else {
            page = result.page;
            browser = result.browser;
            await sendTelegramMessage(`✅ *代理已切换*\n新IP通过代理: ${currentProxy.server}`);

            for (const idx of needProxyRetry) {
                const user = users[idx];
                const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                console.log(`\n=== [代理重试] 用户 ${idx + 1}/${users.length} ===`);

                let loginSuccess = false;
                for (let la = 1; la <= 3; la++) {
                    console.log(`\n[代理登录 ${la}/3] ${currentProxy.server}`);
                    if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(1500); }
                    await page.goto('https://dashboard.katabump.com/auth/login'); await page.waitForTimeout(2000);
                    if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(1500); await page.goto('https://dashboard.katabump.com/auth/login'); await page.waitForTimeout(2000); }

                    try {
                        const emailInput = page.getByRole('textbox', { name: 'Email' });
                        await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                        await emailInput.fill(user.username);
                        await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
                        await page.waitForTimeout(500);

                        if (await hasAltchaWidget(page)) { await solveAltcha(page); }
                        else { let clicked = false; for (let t = 0; t < 18; t++) { if (await attemptTurnstileCdp(page)) { clicked = true; break; } await page.waitForTimeout(800); } if (clicked) await page.waitForTimeout(2500); }

                        await page.getByRole('button', { name: 'Login', exact: true }).click();
                        await page.waitForTimeout(3500);

                        if (await page.getByText('Please complete captcha').isVisible({ timeout: 3000 }).catch(() => false)) { console.log(`   >> ⚠️ 验证码未通过（${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; }
                        if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 3000 }).catch(() => false)) { console.error('   >> ❌ 密码错误'); loginSuccess = false; break; }
                        if (page.url().includes('dashboard')) { loginSuccess = true; console.log('   >> ✅ 代理登录成功！'); break; }
                        if (page.url().includes('login')) { console.log(`   >> 仍在登录页`); await page.reload(); await page.waitForTimeout(2000); continue; }
                    } catch (e) { console.log('登录错误:', e.message); }
                }

                if (!loginSuccess) { console.log('   >> 代理也失败，跳过。'); continue; }

                const seeOk = await findAndClickSeeButton(page);
                if (!seeOk) { await navigateToServerEdit(page, user); }

                for (let attempt = 1; attempt <= 20; attempt++) {
                    const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                    try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}
                    if (!(await renewBtn.isVisible())) { console.log('未找到 Renew。'); break; }
                    await renewBtn.click();
                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { continue; }

                    if (await hasAltchaWidget(page)) { await solveAltcha(page); }
                    else { let clicked = false; for (let t = 0; t < 25; t++) { if (await attemptTurnstileCdp(page)) { clicked = true; break; } await page.waitForTimeout(1000); } if (clicked) await page.waitForTimeout(2500); }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (!(await confirmBtn.isVisible())) { await page.reload(); await page.waitForTimeout(3000); continue; }
                    await confirmBtn.click(); await page.waitForTimeout(3000);

                    if (await page.getByText('Please complete the captcha to continue').isVisible({ timeout: 2000 }).catch(() => false)) { await page.reload(); await page.waitForTimeout(3000); continue; }
                    const notTimeLoc = page.getByText("You can't renew your server yet");
                    if (await notTimeLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
                        const text = await notTimeLoc.innerText(); const m = text.match(/as of\s+(.*?)\s+\(/); const ds = m ? m[1] : 'Unknown';
                        console.log(`   >> ⏳ 暂无法续期。下次: ${ds}`);
                        try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_skip.png`), fullPage: true }); } catch (e) {}
                        await sendTelegramMessage(`⏳ *暂无法续期（代理）*\n用户${idx + 1}: ${ds}`);
                        try { const cb = modal.getByLabel('Close'); if (await cb.isVisible()) await cb.click(); } catch (e) {}
                        break;
                    }
                    if (!(await modal.isVisible({ timeout: 1000 }).catch(() => false))) {
                        console.log('   >> ✅ 代理续期成功！');
                        try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_proxy_success.png`), fullPage: true }); } catch (e) {}
                        await sendTelegramMessage(`✅ *代理续期成功*\n用户${idx + 1}`);
                        break;
                    }
                    await page.reload(); await page.waitForTimeout(3000);
                }
                try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_proxy.png`), fullPage: true }); } catch (e) {}
            }
        }
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
