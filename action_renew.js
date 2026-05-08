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

// 收集所有推送消息
const wxMessages = [];

async function sendWxPusher(content) {
    try {
        await axios.post('https://wxpusher.zjiecode.com/api/send/message', {
            appToken: WX_APP_TOKEN,
            content: content,
            contentType: 1,
            uids: [WX_UID]
        }, { timeout: 10000 });
        console.log('[WxPusher] 推送成功:', content.substring(0, 60));
    } catch (e) {
        console.error('[WxPusher] 推送失败:', e.message);
    }
}

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' });
        console.log('[Telegram] Message sent.');
    } catch (e) { console.error('[Telegram] send error:', e.message); }
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
    try {
        const u = new URL(HTTP_PROXY);
        PROXY_CONFIG = { server: `${u.protocol}//${u.hostname}:${u.port}`, username: u.username ? decodeURIComponent(u.username) : undefined, password: u.password ? decodeURIComponent(u.password) : undefined };
        console.log(`[代理] ${PROXY_CONFIG.server}`);
    } catch (e) { process.exit(1); }
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
    } catch (e) { console.error('解析USERS_JSON出错:', e.message); }
    return [];
}

async function checkProxy() { if (!PROXY_CONFIG) return true; try { const ac = { proxy: { protocol: 'http', host: new URL(PROXY_CONFIG.server).hostname, port: new URL(PROXY_CONFIG.server).port }, timeout: 10000 }; if (PROXY_CONFIG.username) ac.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password }; await axios.get('https://www.google.com', ac); return true; } catch (e) { return false; } }
function checkPort(p) { return new Promise(r => { const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); req.on('error', () => r(false)); req.end(); }); }

async function launchChrome() {
    console.log('检查 Chrome 端口 ' + DEBUG_PORT + '...');
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }
    console.log('正在启动 Chrome...');
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'];
    if (PROXY_CONFIG) { args.push(`--proxy-server=${PROXY_CONFIG.server}`); args.push('--proxy-bypass-list=<-loopback>'); }
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
    if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome 启动失败');
}

(async () => {
    const users = getUsers();
    if (users.length === 0) { console.log('未找到用户'); process.exit(1); }
    if (PROXY_CONFIG && !(await checkProxy())) { console.error('代理无效'); process.exit(1); }
    await launchChrome();

    let browser;
    for (let k = 0; k < 5; k++) { try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); console.log('连接成功！'); break; } catch { await new Promise(r => setTimeout(r, 2000)); } }
    if (!browser) { console.error('连接失败'); process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);
    if (PROXY_CONFIG?.username) await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    else await context.setHTTPCredentials(null);
    await page.addInitScript(INJECTED_SCRIPT);

    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const userLabel = `用户${i + 1}`;
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 处理 ${userLabel} ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }

            let loginSuccess = false;
            for (let la = 1; la <= 3; la++) {
                console.log(`\n[登录尝试 ${la}/3]`);
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
                        console.log('   >> Turnstile CDP...');
                        let clicked = false;
                        for (let t = 0; t < 18; t++) { if (await attemptTurnstileCdp(page)) { clicked = true; break; } await page.waitForTimeout(800); }
                        if (!clicked) { console.log(`   >> ⚠️ CDP 未点击到（尝试 ${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; }
                        await page.waitForTimeout(2500);
                    }

                    await page.getByRole('button', { name: 'Login', exact: true }).click();
                    await page.waitForTimeout(3500);

                    if (await page.getByText('Please complete captcha').isVisible({ timeout: 3000 }).catch(() => false)) { console.log(`   >> ⚠️ 验证码未通过（尝试 ${la}/3）`); await page.reload(); await page.waitForTimeout(2000); continue; }
                    if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 3000 }).catch(() => false)) {
                        console.error('   >> ❌ 密码错误');
                        wxMessages.push(`${userLabel} 登录失败：密码错误`);
                        const failPath = path.join(shotDir, `${safeUser}_login_fail.png`);
                        try { await page.screenshot({ path: failPath, fullPage: true }); } catch (e) {}
                        await sendTelegramMessage(`❌ *登录失败*\n${userLabel}: 密码错误`, failPath);
                        loginSuccess = false; break;
                    }
                    if (page.url().includes('dashboard')) { loginSuccess = true; console.log('   >> ✅ 登录成功！'); break; }
                    if (page.url().includes('login') || page.url().includes('auth')) { console.log(`   >> 仍在登录页（尝试 ${la}/3），重试...`); await page.reload(); await page.waitForTimeout(2000); continue; }
                    console.log(`   >> 状态未知（${page.url()}），重试...`); await page.reload(); await page.waitForTimeout(2000);
                } catch (e) { console.log('登录错误:', e.message); }
            }

            if (!loginSuccess) { console.log('   >> 登录最终失败，跳过。'); continue; }

            const seeOk = await findAndClickSeeButton(page);
            if (!seeOk) { console.log('   >> See 按钮未找到，兜底导航...'); await navigateToServerEdit(page, user); }

            for (let attempt = 1; attempt <= 20; attempt++) {
                console.log(`\n[尝试 ${attempt}/20] 寻找 Renew...`);
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
                        await confirmBtn.click();
                        await page.waitForTimeout(3000);

                        if (await page.getByText('Please complete the captcha to continue').isVisible({ timeout: 2000 }).catch(() => false)) { console.log('   >> ⚠️ captcha 错误，刷新...'); await page.reload(); await page.waitForTimeout(3000); continue; }

                        const notTimeLoc = page.getByText("You can't renew your server yet");
                        if (await notTimeLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
                            const text = await notTimeLoc.innerText();
                            const m = text.match(/as of\s+(.*?)\s+\(/);
                            const ds = m ? m[1] : 'Unknown';
                            console.log(`   >> ⏳ 暂无法续期。下次: ${ds}`);
                            const wxMsg = `${userLabel}暂无法续期。下次: ${ds}`;
                            wxMessages.push(wxMsg);
                            await sendWxPusher(wxMsg);

                            try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_skip.png`), fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`⏳ *暂无法续期*\n${userLabel}: ${ds}`);
                            try { const cb = modal.getByLabel('Close'); if (await cb.isVisible()) await cb.click(); } catch (e) {}
                            break;
                        }

                        if (!(await modal.isVisible({ timeout: 1000 }).catch(() => false))) {
                            console.log('   >> ✅ 续期成功！');
                            const wxMsg = `${userLabel}续期成功！`;
                            wxMessages.push(wxMsg);
                            await sendWxPusher(wxMsg);

                            try { await page.screenshot({ path: path.join(shotDir, `${safeUser}_success.png`), fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`✅ *续期成功*\n${userLabel}`);
                            break;
                        } else { console.log('   >> 模态框仍打开，刷新重试...'); await page.reload(); await page.waitForTimeout(3000); continue; }
                    } else { await page.reload(); await page.waitForTimeout(3000); continue; }
                } else { console.log('未找到 Renew 按钮。'); break; }
            }
        } catch (err) { console.error('处理用户出错:', err.message); }

        try { await page.screenshot({ path: path.join(shotDir, `${safeUser}.png`), fullPage: true }); } catch (e) {}
        console.log(`${userLabel}处理完成\n`);
    }

    // 全部处理完，WxPusher 汇总
    if (wxMessages.length > 0) {
        const summary = wxMessages.join('\n');
        console.log('\n===== WxPusher 汇总 =====');
        console.log(summary);
        // 如果有多条，额外发一条汇总
        if (wxMessages.length > 1) {
            await sendWxPusher('【汇总】\n' + summary);
        }
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
