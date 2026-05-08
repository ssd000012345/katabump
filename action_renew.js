const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const WX_APP_TOKEN = 'AT_Fl4H5xzMp8AdgFWPnF4YT5NHAzwN7YZM';
const WX_UID = 'UID_OieYS9Vq15lpKhxFaFYOljIauPAA';

async function sendWxPusher(content) {
    try { await axios.post('https://wxpusher.zjiecode.com/api/send/message', { appToken: WX_APP_TOKEN, content, contentType: 1, uids: [WX_UID] }, { timeout: 10000 }); console.log('[WxPusher] 推送成功'); } catch (e) { console.error('[WxPusher] 失败:', e.message); }
}

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

// INJECTED_SCRIPT — 融入图片中的思路：
// 1. screenX/screenY 随机化（模仿 undetected-chromedriver）
// 2. iframe 内 attachShadow hook 定位 checkbox
// 3. 主 frame 轮询 ALTCHA widget
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

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'];
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) return; await new Promise(r => setTimeout(r, 1000)); }
    throw new Error('Chrome 启动失败');
}

// ==================== CDP 点击（融入文章思路：mouseMoved 轨迹 + 多次点 + 随机偏移） ====================
async function cdpClickAt(page, x, y) {
    const client = await page.context().newCDPSession(page);
    // 起点：目标附近随机偏移
    const sx = x - 50 + Math.random() * 100;
    const sy = y - 40 + Math.random() * 80;
    // 随机分段轨迹（3~6 段）
    const segments = 3 + Math.floor(Math.random() * 4);
    for (let i = 1; i <= segments; i++) {
        const t = i / segments;
        const ease = 1 - Math.pow(1 - t, 2);
        const mx = sx + (x - sx) * ease + (Math.random() - 0.5) * 3;
        const my = sy + (y - sy) * ease + (Math.random() - 0.5) * 3;
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my });
        await new Promise(r => setTimeout(r, 15 + Math.random() * 35));
    }
    // 悬停
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await new Promise(r => setTimeout(r, 40 + Math.random() * 120));
    // 点击
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50 + Math.random() * 120));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await client.detach();
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;
            if (data.type === 'altcha' && frame === page.mainFrame()) {
                const vp = page.viewportSize(); if (!vp) continue;
                await cdpClickAt(page, vp.width * data.xRatio, vp.height * data.yRatio);
                console.log('   >> [ALTCHA CDP] 点击完成');
                return true;
            }
            const iframeElement = await frame.frameElement(); if (!iframeElement) continue;
            const box = await iframeElement.boundingBox(); if (!box) continue;
            const clickX = box.x + box.width * data.xRatio + (Math.random() - 0.5) * 4;
            const clickY = box.y + box.height * data.yRatio + (Math.random() - 0.5) * 4;
            console.log(`   >> [Turnstile] 点击 (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
            await cdpClickAt(page, clickX, clickY);
            return true;
        } catch (e) {}
    }
    return false;
}
// ============================================================================================

async function hasAltchaWidget(page) { return await page.evaluate(() => !!document.querySelector('altcha-widget')); }
async function getAltchaState(page) { return await page.evaluate(() => { const w = document.querySelector('altcha-widget'); if (!w) return null; if (typeof w.getState === 'function') { const s = w.getState(); if (s) return s; } const i = w.shadowRoot?.querySelector('.altcha'); if (i) { const s = i.getAttribute('data-state'); if (s) return s; } return w.getAttribute('data-state'); }); }
async function waitForAltchaVerified(page, t = 15) { for (let s = 0; s < t; s++) { const st = await getAltchaState(page); if (st === 'verified') return true; if (st === 'error') return false; await page.waitForTimeout(1000); } return false; }
async function solveAltchaByClick(page) { for (let a = 0; a < 8; a++) { if ((await getAltchaState(page)) === 'verified') return true; try { const cb = page.locator('.altcha-checkbox').first(); if (await cb.isVisible({ timeout: 2000 })) { await cb.click({ timeout: 3000 }); if (await waitForAltchaVerified(page, 10)) return true; } } catch (e) {} await page.waitForTimeout(800); } return false; }
async function solveAltchaByAPI(page) { try { if ((await getAltchaState(page)) === 'verified') return true; const ok = await page.evaluate(() => { const w = document.querySelector('altcha-widget'); if (w && typeof w.verify === 'function') { w.verify(); return true; } return false; }); if (ok && await waitForAltchaVerified(page, 12)) return true; } catch (e) {} return false; }
async function solveAltcha(page) { if (!(await hasAltchaWidget(page))) return false; if (await solveAltchaByClick(page)) return true; return await solveAltchaByAPI(page); }

async function findAndClickSeeButton(page) {
    const strategies = [() => page.getByRole('link', { name: 'See' }).first(), () => page.locator('a[href*="servers/edit"]').first(), () => page.locator('a').filter({ hasText: 'See' }).first(), () => page.locator('a[aria-label*="See"]').first()];
    for (let i = 0; i < 10; i++) { for (const g of strategies) { try { const l = g(); if (await l.isVisible({ timeout: 1500 })) { await l.click({ timeout: 5000 }); return true; } } catch (e) {} } await page.waitForTimeout(1200); }
    return false;
}

async function navigateToServerEdit(page, user) { const sid = user.serverId || process.env.KATABUMP_SERVER_ID || '266194'; await page.goto(`https://dashboard.katabump.com/servers/edit?id=${sid}`, { waitUntil: 'networkidle', timeout: 30000 }); await page.waitForTimeout(3000); }

function getUsers() { try { if (process.env.USERS_JSON) { const p = JSON.parse(process.env.USERS_JSON); if (Array.isArray(p)) return p; if (p?.users) return p.users; } } catch (e) {} return []; }

async function doLogin(page, user, safeUser, shotDir) {
    for (let la = 1; la <= 3; la++) {
        console.log(`   [登录 ${la}/3]`);
        if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout', { waitUntil: 'load', timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1500); }
        try { await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'load', timeout: 15000 }); } catch (e) { console.log('   goto login 超时，重试'); continue; }
        await page.waitForTimeout(2000);
        if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(1500); await page.goto('https://dashboard.katabump.com/auth/login'); await page.waitForTimeout(2000); }

        try {
            const ei = page.getByRole('textbox', { name: 'Email' }); await ei.waitFor({ state: 'visible', timeout: 5000 }); await ei.fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password); await page.waitForTimeout(500);

            if (await hasAltchaWidget(page)) { await solveAltcha(page); }
            else { let c = false; for (let t = 0; t < 18; t++) { if (await attemptTurnstileCdp(page)) { c = true; break; } await page.waitForTimeout(800); } if (c) await page.waitForTimeout(2500); }

            await page.getByRole('button', { name: 'Login', exact: true }).click(); await page.waitForTimeout(3500);

            if (await page.getByText('Please complete captcha').isVisible({ timeout: 3000 }).catch(() => false)) { console.log(`   >> captcha 失败`); await page.reload(); await page.waitForTimeout(2000); continue; }
            if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 3000 }).catch(() => false)) { console.error('   >> 密码错误'); return 'badpass'; }
            if (page.url().includes('dashboard')) { console.log('   >> ✅ 登录成功'); return 'ok'; }
            if (page.url().includes('login') || page.url().includes('auth')) { await page.reload(); await page.waitForTimeout(2000); continue; }
            await page.reload(); await page.waitForTimeout(2000);
        } catch (e) { console.log('   登录错误:', e.message); }
    }
    return 'captcha';
}

async function doRenew(page, user, shotDir, safeUser) {
    for (let attempt = 1; attempt <= 20; attempt++) {
        const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
        try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}
        if (!(await renewBtn.isVisible())) { console.log('   未找到 Renew'); return 'done'; }
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
        if (!(await modal.isVisible({ timeout: 1000 }).catch(() => false))) { console.log('   >> ✅ 续期成功'); return { status: 'success' }; }
        await page.reload(); await page.waitForTimeout(3000);
    }
    return 'done';
}

(async () => {
    const users = getUsers();
    if (users.length === 0) { console.log('未找到用户'); process.exit(1); }

    await launchChrome();
    let browser;
    for (let k = 0; k < 5; k++) { try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); console.log('Chrome 已连接'); break; } catch { await new Promise(r => setTimeout(r, 2000)); } }
    if (!browser) { process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);
    await context.setHTTPCredentials(null);
    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入完成');

    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        const label = `用户${i + 1}`;
        console.log(`\n=== ${label} ===`);

        if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }

        const loginResult = await doLogin(page, user, safeUser, shotDir);
        if (loginResult === 'badpass') { await sendWxPusher(`${label} 登录失败：密码错误`); await sendTelegramMessage(`❌ *${label}* 密码错误`); continue; }
        if (loginResult === 'captcha') { await sendWxPusher(`${label} Turnstile未通过`); await sendTelegramMessage(`❌ *${label}* Turnstile未通过`); continue; }
        if (loginResult !== 'ok') { console.log('   >> 登录失败'); continue; }

        if (!(await findAndClickSeeButton(page))) { await navigateToServerEdit(page, user); }

        const renewResult = await doRenew(page, user, shotDir, safeUser);
        const status = typeof renewResult === 'object' ? renewResult.status : renewResult;
        const date = renewResult.date || '';

        if (status === 'success') {
            console.log(`   ${label}: ✅ 续期成功`);
            await sendWxPusher(`${label}续期成功！`);
            await sendTelegramMessage(`✅ *${label}* 续期成功`);
        } else if (status === 'skip') {
            console.log(`   ${label}: ⏳ ${date}`);
            await sendWxPusher(`${label}暂无法续期。下次: ${date}`);
            await sendTelegramMessage(`⏳ *${label}* ${date}`);
        }

        try { await page.screenshot({ path: path.join(shotDir, `${safeUser}.png`), fullPage: true }); } catch (e) {}
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
