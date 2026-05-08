const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try { await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' }); } catch (e) {}
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

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) {
        const da = () => {
            const w = document.querySelector('altcha-widget');
            if (w && w.shadowRoot) { const cb = w.shadowRoot.querySelector('.altcha-checkbox'); if (cb) { const r = cb.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { window.__turnstile_data = { xRatio: (r.left + r.width/2) / window.innerWidth, yRatio: (r.top + r.height/2) / window.innerHeight, type: 'altcha' }; return true; } } }
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

function checkPort(p) { return new Promise(r => { const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); req.on('error', () => r(false)); req.end(); }); }

async function checkProxyAlive() {
    if (!currentProxy?.server) return true;
    try { const u = new URL(currentProxy.server); await axios.get('https://www.google.com', { proxy: { protocol: 'http', host: u.hostname, port: parseInt(u.port) }, timeout: 8000 }); return true; } catch (e) { return false; }
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) { console.log('   Chrome 已在运行'); return; }
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'];
    if (currentProxy?.server) { args.push(`--proxy-server=${currentProxy.server}`); args.push('--proxy-bypass-list=<-loopback>'); }
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) { console.log('   Chrome 启动完成'); return; } await new Promise(r => setTimeout(r, 1000)); }
    throw new Error('Chrome 启动失败');
}

async function killChrome() {
    console.log('   正在杀掉旧 Chrome...');
    try { execSync('pkill -f "chrome.*9222" || true', { stdio: 'ignore' }); } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
    for (let i = 0; i < 15; i++) {
        if (!(await checkPort(DEBUG_PORT))) { console.log('   端口已释放'); return; }
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log('   强制杀端口...');
    try { execSync('fuser -k 9222/tcp || true', { stdio: 'ignore' }); } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
}

async function safeGoto(page, url, label) {
    try { await page.goto(url, { waitUntil: 'load', timeout: 15000 }); return true; }
    catch (e) { console.log(`   [${label}] 网络错误: ${e.message.substring(0, 80)}`); return false; }
}

async function fetchFreeProxies() {
    const sources = [
        { name: 'proxyscrape', url: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all' },
        { name: 'proxylist', url: 'https://www.proxy-list.download/api/v1/get?type=http' },
        { name: 'geonode', url: 'https://proxylist.geonode.com/api/proxy-list?limit=10&page=1&sort_by=lastChecked&sort_type=desc&protocols=http' }
    ];
    for (const src of sources) {
        try {
            const res = await axios.get(src.url, { timeout: 15000 });
            let lines = [];
            if (typeof res.data === 'string') lines = res.data.split('\n').filter(l => l.trim() && l.includes(':') && !l.startsWith('#'));
            else if (Array.isArray(res.data?.data)) lines = res.data.data.map(p => `${p.ip}:${p.port}`);
            const proxies = lines.map(l => { const c = l.trim().replace(/\r/g, ''); return c.startsWith('http') ? c : `http://${c}`; }).filter(p => { try { const u = new URL(p); return u.hostname && u.port; } catch (e) { return false; } });
            if (proxies.length > 0) { console.log(`   [代理池] ${src.name}: ${proxies.length} 个`); return proxies; }
        } catch (e) { console.log(`   [代理池] ${src.name}: ${e.message}`); }
    }
    return [];
}

async function testProxy(proxyUrl) {
    try { const u = new URL(proxyUrl); await axios.get('https://www.google.com', { proxy: { protocol: 'http', host: u.hostname, port: parseInt(u.port) }, timeout: 8000 }); return true; } catch (e) { return false; }
}

async function switchToProxy(oldBrowser) {
    if (freeProxyPool.length === 0) freeProxyPool = await fetchFreeProxies();
    while (freeProxyPool.length > 0) {
        const proxyUrl = freeProxyPool.shift();
        console.log(`   [代理切换] 测试 ${proxyUrl}...`);
        if (!(await testProxy(proxyUrl))) { console.log(`   不可用`); continue; }
        console.log(`   ✅ ${proxyUrl} 可用`);

        const u = new URL(proxyUrl);
        currentProxy = { server: `${u.protocol}//${u.hostname}:${u.port}` };

        try { await oldBrowser.close(); } catch (e) {}
        await killChrome();
        await launchChrome();

        let browser, page;
        try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); }
        catch (e) { console.log('   重连失败，换下一个'); continue; }

        const ctx = browser.contexts()[0];
        page = ctx.pages().length > 0 ? ctx.pages()[0] : await ctx.newPage();
        page.setDefaultTimeout(60000);
        await ctx.setHTTPCredentials(null);
        await page.addInitScript(INJECTED_SCRIPT);

        console.log('   测试目标网站连通性...');
        if (!(await safeGoto(page, 'https://dashboard.katabump.com/auth/login', '代理测试'))) {
            console.log('   代理无法访问目标，换下一个');
            try { await browser.close(); } catch (e) {}
            await killChrome();
            continue;
        }
        await page.waitForTimeout(2000);

        console.log(`   [代理切换] 完成: ${currentProxy.server}`);
        return { page, browser, ok: true };
    }
    console.log('   [代理切换] 池耗尽');
    return { ok: false };
}

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
            const iframeElement = await frame.frameElement(); if (!iframeElement) continue;
            const box = await iframeElement.boundingBox(); if (!box) continue;
            const clickX = box.x + (box.width * data.xRatio), clickY = box.y + (box.height * data.yRatio);
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
async function waitForAltchaVerified(page, t = 15) { for (let s = 0; s < t; s++) { const st = await getAltchaState(page); if (st === 'verified') return true; if (st === 'error') return false; await page.waitForTimeout(1000); } return false; }
async function solveAltchaByClick(page) { for (let a = 0; a < 8; a++) { if ((await getAltchaState(page)) === 'verified') return true; try { const cb = page.locator('.altcha-checkbox').first(); if (await cb.isVisible({ timeout: 2000 })) { await cb.click({ timeout: 3000 }); if (await waitForAltchaVerified(page, 10)) return true; } } catch (e) {} await page.waitForTimeout(800); } return false; }
async function solveAltchaByAPI(page) { try { if ((await getAltchaState(page)) === 'verified') return true; const ok = await page.evaluate(() => { const w = document.querySelector('altcha-widget'); if (w && typeof w.verify === 'function') { w.verify(); return true; } return false; }); if (ok && await waitForAltchaVerified(page, 12)) return true; } catch (e) {} return false; }
async function solveAltcha(page) { if (!(await hasAltchaWidget(page))) return false; if (await solveAltchaByClick(page)) return true; return await solveAltchaByAPI(page); }

async function findAndClickSeeButton(page) {
    const strategies = [() => page.getByRole('link', { name: 'See' }).first(), () => page.locator('a[href*="servers/edit"]').first(), () => page.locator('a').filter({ hasText: 'See' }).first(), () => page.locator('a[aria-label*="See"]').first()];
    for (let i = 0; i < 10; i++) {
        for (const g of strategies) { try { const l = g(); if (await l.isVisible({ timeout: 1500 })) { await l.click({ timeout: 5000 }); return true; } } catch (e) {} }
        await page.waitForTimeout(1200);
    }
    return false;
}

async function navigateToServerEdit(page, user) { const sid = user.serverId || process.env.KATABUMP_SERVER_ID || '266194'; await page.goto(`https://dashboard.katabump.com/servers/edit?id=${sid}`, { waitUntil: 'networkidle', timeout: 30000 }); await page.waitForTimeout(3000); }

function getUsers() { try { if (process.env.USERS_JSON) { const p = JSON.parse(process.env.USERS_JSON); if (Array.isArray(p)) return p; if (p?.users) return p.users; } } catch (e) {} return []; }

async function doLogin(page, user) {
    for (let la = 1; la <= 3; la++) {
        console.log(`\n[登录尝试 ${la}/3]${currentProxy ? ' [代理]' : ' [无代理]'}`);
        if (page.url().includes('dashboard')) { await safeGoto(page, 'https://dashboard.katabump.com/auth/logout', 'logout'); await page.waitForTimeout(1500); }
        if (!(await safeGoto(page, 'https://dashboard.katabump.com/auth/login', 'login'))) return 'netfail';
        await page.waitForTimeout(2000);
        if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(1500); if (!(await safeGoto(page, 'https://dashboard.katabump.com/auth/login', 'login2'))) return 'netfail'; await page.waitForTimeout(2000); }

        try {
            const ei = page.getByRole('textbox', { name: 'Email' }); await ei.waitFor({ state: 'visible', timeout: 5000 }); await ei.fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password); await page.waitForTimeout(500);

            if (await hasAltchaWidget(page)) { await solveAltcha(page); }
            else { let c = false; for (let t = 0; t < 18; t++) { if (await attemptTurnstileCdp(page)) { c = true; break; } await page.waitForTimeout(800); } if (c) await page.waitForTimeout(2500); }

            await page.getByRole('button', { name: 'Login', exact: true }).click(); await page.waitForTimeout(3500);

            if (await page.getByText('Please complete captcha').isVisible({ timeout: 3000 }).catch(() => false)) { console.log(`   >> ⚠️ 验证码未通过（${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; }
            if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 3000 }).catch(() => false)) { console.error('   >> ❌ 密码错误'); return 'badpass'; }
            if (page.url().includes('dashboard')) { console.log('   >> ✅ 登录成功！'); return 'ok'; }
            if (page.url().includes('login') || page.url().includes('auth')) { console.log(`   >> 仍在登录页（${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; }
            await page.reload(); await page.waitForTimeout(2000);
        } catch (e) { console.log('登录错误:', e.message); }
    }
    return 'captcha';
}

async function doRenew(page, user, shotDir, safeUser) {
    for (let attempt = 1; attempt <= 20; attempt++) {
        const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
        try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}
        if (!(await renewBtn.isVisible())) { console.log('未找到 Renew。'); return 'done'; }
        await renewBtn.click();
        const modal = page.locator('#renew-modal');
        try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { continue; }
        try { const box = await modal.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); } catch (e) {}

        if (await hasAltchaWidget(page)) { await solveAltcha(page); }
        else { let c = false; for (let t = 0; t < 25; t++) { if (await attemptTurnstileCdp(page)) { c = true; break; } await page.waitForTimeout(1000); } if (c) await page.waitForTimeout(2500); }

        const confirmBtn = modal.getByRole('button', { name: 'Renew' });
        if (!(await confirmBtn.isVisible())) { await page.reload(); await page.waitForTimeout(3000); continue; }
        try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_modal_${attempt}.png`), fullPage: true }); } catch (e) {}
        await confirmBtn.click(); await page.waitForTimeout(3000);

        if (await page.getByText('Please complete the captcha to continue').isVisible({ timeout: 2000 }).catch(() => false)) { await page.reload(); await page.waitForTimeout(3000); continue; }
        const notTimeLoc = page.getByText("You can't renew your server yet");
        if (await notTimeLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
            const text = await notTimeLoc.innerText(); const m = text.match(/as of\s+(.*?)\s+\(/); const ds = m ? m[1] : 'Unknown';
            console.log(`   >> ⏳ 暂无法续期。下次: ${ds}`);
            try { const cb = modal.getByLabel('Close'); if (await cb.isVisible()) await cb.click(); } catch (e) {}
            return { status: 'skip', date: ds };
        }
        if (!(await modal.isVisible({ timeout: 1000 }).catch(() => false))) { console.log('   >> ✅ 续期成功！'); return { status: 'success' }; }
        await page.reload(); await page.waitForTimeout(3000);
    }
    return 'done';
}

async function processUser(page, user, shotDir, userIdx) {
    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
    const loginResult = await doLogin(page, user);
    if (loginResult === 'badpass') return { idx: userIdx, status: 'badpass' };
    if (loginResult === 'netfail') return { idx: userIdx, status: 'netfail' };
    if (loginResult === 'captcha') return { idx: userIdx, status: 'captcha' };

    if (!(await findAndClickSeeButton(page))) await navigateToServerEdit(page, user);

    const renewResult = await doRenew(page, user, shotDir, safeUser);
    const result = { idx: userIdx, status: typeof renewResult === 'object' ? renewResult.status : renewResult, date: renewResult.date || null };
    try { await page.screenshot({ path: path.join(shotDir, `${safeUser}.png`), fullPage: true }); } catch (e) {}
    return result;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) { console.log('未找到用户'); process.exit(1); }
    if (currentProxy && !(await checkProxyAlive())) { console.error('预设代理无效'); process.exit(1); }

    if (!currentProxy) { console.log('预取免费代理池...'); freeProxyPool = await fetchFreeProxies(); console.log(`代理池: ${freeProxyPool.length} 个`); }

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

    let needProxyRetry = [];

    // 第一轮：无代理
    for (let i = 0; i < users.length; i++) {
        console.log(`\n=== 处理用户 ${i + 1}/${users.length} ===`);
        const r = await processUser(page, users[i], shotDir, i);
        console.log(`用户${i + 1}: ${r.status}${r.date ? ' ' + r.date : ''}`);

        if (r.status === 'badpass') await sendTelegramMessage(`❌ *登录失败*\n用户${i + 1}: 密码错误`);
        else if (r.status === 'success') await sendTelegramMessage(`✅ *续期成功*\n用户${i + 1}`);
        else if (r.status === 'skip') await sendTelegramMessage(`⏳ *暂无法续期*\n用户${i + 1}: ${r.date}`);
        else needProxyRetry.push(i);
    }

    // 第二轮：代理重试
    if (needProxyRetry.length > 0 && !currentProxy) {
        console.log(`\n===== ${needProxyRetry.length} 个用户需代理重试 =====`);
        await sendTelegramMessage(`🔄 *切换代理重试*\n${needProxyRetry.length} 个用户`);

        const sw = await switchToProxy(browser);
        if (!sw.ok) {
            console.log('代理切换失败');
            await sendTelegramMessage('❌ *代理切换失败*');
        } else {
            page = sw.page; browser = sw.browser;
            await sendTelegramMessage(`✅ *代理已切换*\n${currentProxy.server}`);

            for (const idx of needProxyRetry) {
                console.log(`\n=== [代理重试] 用户 ${idx + 1} ===`);
                const r = await processUser(page, users[idx], shotDir, idx);
                console.log(`用户${idx + 1}: ${r.status}${r.date ? ' ' + r.date : ''}`);
                if (r.status === 'success') await sendTelegramMessage(`✅ *代理续期成功*\n用户${idx + 1}`);
                else if (r.status === 'skip') await sendTelegramMessage(`⏳ *暂无法续期(代理)*\n用户${idx + 1}: ${r.date}`);
                else await sendTelegramMessage(`❌ *代理也失败*\n用户${idx + 1}: ${r.status}`);
            }
        }
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
