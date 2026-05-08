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
    try { await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' }); }
    catch (e) { console.error('[Telegram] send error:', e.message); }
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(r => exec(cmd, (err) => { if (err) console.error('[Telegram] curl:', err.message); r(); }));
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) {
    try { const u = new URL(HTTP_PROXY); PROXY_CONFIG = { server: `${u.protocol}//${u.hostname}:${u.port}`, username: u.username ? decodeURIComponent(u.username) : undefined, password: u.password ? decodeURIComponent(u.password) : undefined }; }
    catch (e) { process.exit(1); }
}

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

async function checkProxy() { if (!PROXY_CONFIG) return true; try { const ac = { proxy: { protocol: 'http', host: new URL(PROXY_CONFIG.server).hostname, port: new URL(PROXY_CONFIG.server).port }, timeout: 10000 }; if (PROXY_CONFIG.username) ac.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password }; await axios.get('https://www.google.com', ac); return true; } catch (e) { return false; } }
function checkPort(p) { return new Promise(r => { const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); req.on('error', () => r(false)); req.end(); }); }

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'];
    if (PROXY_CONFIG) { args.push(`--proxy-server=${PROXY_CONFIG.server}`); args.push('--proxy-bypass-list=<-loopback>'); }
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
    if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome 启动失败');
}

function getUsers() { try { if (process.env.USERS_JSON) { const p = JSON.parse(process.env.USERS_JSON); return Array.isArray(p) ? p : (p.users || []); } } catch (e) {} return []; }

// ==================== ALTCHA ====================
async function getAltchaState(page) { return await page.evaluate(() => { const w = document.querySelector('altcha-widget'); if (!w) return null; if (typeof w.getState === 'function') { const s = w.getState(); if (s) return s; } const i = w.shadowRoot?.querySelector('.altcha'); if (i) { const s = i.getAttribute('data-state'); if (s) return s; } return w.getAttribute('data-state'); }); }
async function hasAltchaWidget(page) { return await page.evaluate(() => !!document.querySelector('altcha-widget')); }
async function waitForAltchaVerified(page, t = 10) { for (let s = 0; s < t; s++) { const st = await getAltchaState(page); if (st === 'verified') return true; if (st === 'error') return false; await page.waitForTimeout(1000); } return false; }
async function solveAltchaByClick(page) { for (let a = 0; a < 5; a++) { try { if ((await getAltchaState(page)) === 'verified') return true; const cb = page.locator('.altcha-checkbox').first(); if (await cb.count() === 0) { await page.waitForTimeout(1000); continue; } const box = await cb.boundingBox(); if (!box || box.width === 0) { await page.waitForTimeout(500); continue; } await cb.click({ timeout: 3000 }); if (await waitForAltchaVerified(page, 10)) return true; const s = await getAltchaState(page); if (s === 'verified' || s === 'verifying') return true; return false; } catch (e) {} await page.waitForTimeout(500); } return false; }
async function solveAltchaByAPI(page) { for (let a = 0; a < 3; a++) { try { if ((await getAltchaState(page)) === 'verified') return true; const ok = await page.evaluate(() => { const w = document.querySelector('altcha-widget'); if (w && typeof w.verify === 'function') { w.verify(); return true; } return false; }); if (ok) { if (await waitForAltchaVerified(page, 10)) return true; } return false; } catch (e) {} await page.waitForTimeout(1000); } return false; }
async function solveAltcha(page) { if (!(await hasAltchaWidget(page))) return false; if (await solveAltchaByClick(page)) return true; if (await solveAltchaByAPI(page)) return true; return false; }

// ==================== Turnstile：多次点击 + 硬等 ====================
async function solveTurnstile(page) {
    // 直接找 Turnstile iframe 内的 clickable 元素，持续点击
    for (let round = 0; round < 10; round++) {
        // 找到所有 Turnstile iframe
        const frames = page.frames();
        let clicked = false;

        for (const frame of frames) {
            // 尝试多种 URL 特征匹配 Turnstile iframe
            const url = frame.url();
            if (!url.includes('cloudflare') && !url.includes('turnstile') && !url.includes('challenges')) continue;

            try {
                // 先尝试 frameLocator + click（Playwright 原生穿透 iframe）
                const cb = frame.locator('input[type="checkbox"]').first();
                if (await cb.count() > 0 && await cb.isVisible().catch(() => false)) {
                    await cb.click({ timeout: 3000 });
                    console.log(`   >> [Round ${round + 1}] iframe checkbox clicked`);
                    clicked = true;
                    break;
                }
            } catch (e) {}

            // 回退：evaluate 点击
            try {
                const ok = await frame.evaluate(() => {
                    const cb = document.querySelector('input[type="checkbox"]');
                    if (!cb || cb.offsetParent === null) return false;
                    cb.focus(); cb.click();
                    cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return true;
                });
                if (ok) { console.log(`   >> [Round ${round + 1}] evaluate click`); clicked = true; break; }
            } catch (e) {}
        }

        // 点击后等 2 秒
        if (clicked) await page.waitForTimeout(2000);

        // 检查 token
        const token = await page.evaluate(() => {
            try {
                if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
                    const t = turnstile.getResponse();
                    if (t && t.length > 10) return t;
                }
                const input = document.querySelector('input[name="cf-turnstile-response"]');
                if (input && input.value && input.value.length > 10) return input.value;
            } catch (e) {}
            return null;
        });

        if (token) {
            console.log(`   >> ✅ Turnstile token (${token.substring(0, 20)}...)`);
            await page.waitForTimeout(2000);
            return true;
        }

        // 没拿到 token，继续等
        if (clicked) console.log(`   >> Waiting... (round ${round + 1})`);
        await page.waitForTimeout(1500);
    }

    return false;
}

async function navigateToServerEdit(page, user) {
    await page.waitForLoadState('networkidle'); await page.waitForTimeout(3000);
    if (!page.url().includes('dashboard')) return false;
    let editUrl = null;
    try { editUrl = await page.evaluate(() => { const ls = document.querySelectorAll('a[href*="servers/edit"]'); for (const l of ls) { if (l.offsetParent !== null) return l.href; } const al = document.querySelectorAll('a'); for (const l of al) { if (l.textContent.trim() === 'See' && l.offsetParent !== null) return l.href; } return null; }); } catch (e) {}
    if (editUrl) { if (!editUrl.startsWith('http')) editUrl = 'https://dashboard.katabump.com' + editUrl; await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 }); }
    else { const sid = user.serverId || process.env.KATABUMP_SERVER_ID || '266194'; await page.goto(`https://dashboard.katabump.com/servers/edit?id=${sid}`, { waitUntil: 'networkidle', timeout: 30000 }); }
    await page.waitForTimeout(3000); return true;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) { console.log('未找到用户'); process.exit(1); }
    if (PROXY_CONFIG && !(await checkProxy())) { console.error('[代理] 无效。'); process.exit(1); }

    await launchChrome();
    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) { try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); console.log('连接成功！'); break; } catch (e) { await new Promise(r => setTimeout(r, 2000)); } }
    if (!browser) { console.error('连接失败。'); process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);
    if (PROXY_CONFIG && PROXY_CONFIG.username) await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    else await context.setHTTPCredentials(null);
    await page.addInitScript(INJECTED_SCRIPT);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }

            let loginSuccess = false;
            for (let la = 1; la <= 3; la++) {
                console.log(`\n[登录尝试 ${la}/3]`);
                if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(2000); }
                await page.goto('https://dashboard.katabump.com/auth/login'); await page.waitForTimeout(2000);
                if (page.url().includes('dashboard')) { await page.goto('https://dashboard.katabump.com/auth/logout'); await page.waitForTimeout(2000); await page.goto('https://dashboard.katabump.com/auth/login'); }

                console.log('正在输入凭据...');
                try {
                    const ei = page.getByRole('textbox', { name: 'Email' }); await ei.waitFor({ state: 'visible', timeout: 5000 }); await ei.fill(user.username);
                    const pi = page.getByRole('textbox', { name: 'Password' }); await pi.fill(user.password); await page.waitForTimeout(500);

                    if (await hasAltchaWidget(page)) { await solveAltcha(page); }
                    else { console.log('   >> Turnstile...'); if (!(await solveTurnstile(page))) { console.log(`   >> ⚠️ 失败（${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; } }

                    await page.getByRole('button', { name: 'Login', exact: true }).click();
                    await page.waitForTimeout(4000);

                    try { if (await page.getByText('Please complete captcha').isVisible({ timeout: 3000 })) { console.log(`   >> ⚠️ captcha 失败（${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; } } catch (e) {}
                    try { if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 2000 })) { console.error('   >> ❌ 密码错误'); loginSuccess = false; break; } } catch (e) {}
                    if (page.url().includes('dashboard')) { loginSuccess = true; console.log('   >> ✅ 登录成功！'); break; }
                    console.log(`   >> 状态未知（${page.url()}）`);
                } catch (e) { console.log('登录错误:', e.message); }
            }
            if (!loginSuccess) { console.log('   >> 登录最终失败，跳过。'); continue; }
            if (!(await navigateToServerEdit(page, user))) { console.log('   >> 导航失败，跳过。'); continue; }

            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;
                console.log(`\n[尝试 ${attempt}/20] 寻找 Renew...`);
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { continue; }
                    try { const box = await modal.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); } catch (e) {}

                    if (await hasAltchaWidget(page)) { await solveAltcha(page); }
                    else { await solveTurnstile(page); }
                    console.log('   >> 等待 3 秒...'); await page.waitForTimeout(3000);

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {
                        const pd = path.join(process.cwd(), 'screenshots'); if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true });
                        const su = user.username.replace(/[^a-z0-9]/gi, '_');
                        try { await page.screenshot({ path: path.join(pd, `${su}_modal_${attempt}.png`), fullPage: true }); } catch (e) {}
                        await confirmBtn.click();
                        try {
                            const t0 = Date.now();
                            while (Date.now() - t0 < 3000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) { hasCaptchaError = true; break; }
                                const nl = page.getByText("You can't renew your server yet");
                                if (await nl.isVisible()) { const text = await nl.innerText(); const m = text.match(/as of\s+(.*?)\s+\(/); let ds = m ? m[1] : 'Unknown'; console.log(`   >> ⏳ 暂无法续期。下次: ${ds}`); try { await page.screenshot({ path: path.join(pd, `${su}_skip.png`), fullPage: true }); } catch (e) {} await sendTelegramMessage(`⏳ *暂无法续期*\n用户: ${user.username}\n下次可用: ${ds}`); renewSuccess = true; try { const cb = modal.getByLabel('Close'); if (await cb.isVisible()) await cb.click(); } catch (e) {} break; }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) {}
                        if (renewSuccess) break;
                        if (hasCaptchaError) { await page.reload(); await page.waitForTimeout(3000); continue; }
                        await page.waitForTimeout(2000);
                        if (!(await modal.isVisible())) { console.log('   >> ✅ 续期成功！'); try { await page.screenshot({ path: path.join(pd, `${su}_success.png`), fullPage: true }); } catch (e) {} await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}`); renewSuccess = true; break; }
                        else { await page.reload(); await page.waitForTimeout(3000); continue; }
                    } else { await page.reload(); await page.waitForTimeout(3000); continue; }
                } else { console.log('未找到 Renew 按钮。'); break; }
            }
        } catch (err) { console.error('处理用户出错:', err); }
        const pd = path.join(process.cwd(), 'screenshots'); if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true });
        try { await page.screenshot({ path: path.join(pd, `${user.username.replace(/[^a-z0-9]/gi, '_')}.png`), fullPage: true }); } catch (e) {}
        console.log('用户处理完成\n');
    }
    console.log('完成。'); await browser.close(); process.exit(0);
})();
