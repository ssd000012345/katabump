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
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error('[Telegram] send error:', e.message);
    }
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
if (HTTP_PROXY) {
    try {
        const u = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${u.protocol}//${u.hostname}:${u.port}`,
            username: u.username ? decodeURIComponent(u.username) : undefined,
            password: u.password ? decodeURIComponent(u.password) : undefined
        };
    } catch (e) { process.exit(1); }
}

// ==================== 注入脚本 ====================
const INJECTED_SCRIPT = `(function() {
    if (window.self === window.top) return;
    try {
        function ri(m,M){return Math.floor(Math.random()*(M-m+1))+m;}
        Object.defineProperty(MouseEvent.prototype,'screenX',{value:ri(800,1200)});
        Object.defineProperty(MouseEvent.prototype,'screenY',{value:ri(400,600)});
    } catch(e){}
    try {
        const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(i) {
            const sr = orig.call(this, i);
            if (sr) {
                const ck = () => {
                    const cb = sr.querySelector('input[type="checkbox"]');
                    if (cb) {
                        const r = cb.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            window.__turnstile_data = {
                                xRatio: (r.left + r.width/2) / window.innerWidth,
                                yRatio: (r.top + r.height/2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                if (!ck()) {
                    const ob = new MutationObserver(() => { if (ck()) ob.disconnect(); });
                    ob.observe(sr, { childList: true, subtree: true });
                }
            }
            return sr;
        };
    } catch(e){}
})();`;

// ==================== CDP 点击 Turnstile ====================
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await client.detach();
                return true;
            }
        } catch (e) {}
    }
    return false;
}

// ==================== ALTCHA 处理 ====================
async function getAltchaState(page) {
    return await page.evaluate(() => {
        const w = document.querySelector('altcha-widget');
        if (!w) return null;
        if (typeof w.getState === 'function') {
            const s = w.getState(); if (s) return s;
        }
        const i = w.shadowRoot?.querySelector('.altcha');
        if (i) {
            const s = i.getAttribute('data-state'); if (s) return s;
        }
        return w.getAttribute('data-state');
    });
}

async function hasAltchaWidget(page) {
    return await page.evaluate(() => !!document.querySelector('altcha-widget'));
}

async function waitForAltchaVerified(page) {
    for (let s = 0; s < 15; s++) {
        const st = await getAltchaState(page);
        if (st === 'verified') return true;
        if (st === 'error') return false;
        await page.waitForTimeout(1000);
    }
    return false;
}

async function solveAltcha(page) {
    if (!(await hasAltchaWidget(page))) return false;
    for (let a = 0; a < 8; a++) {
        if ((await getAltchaState(page)) === 'verified') return true;

        try {
            const cb = page.locator('.altcha-checkbox').first();
            if (await cb.isVisible({ timeout: 2000 })) {
                await cb.click({ timeout: 3000 });
                if (await waitForAltchaVerified(page)) return true;
            }
        } catch (e) {}

        try {
            const ok = await page.evaluate(() => {
                const w = document.querySelector('altcha-widget');
                if (w && typeof w.verify === 'function') { w.verify(); return true; }
                return false;
            });
            if (ok && await waitForAltchaVerified(page)) return true;
        } catch (e) {}

        await page.waitForTimeout(800);
    }
    return false;
}

// ==================== 稳定查找 See 按钮 ====================
async function findAndClickSeeButton(page) {
    const strategies = [
        () => page.getByRole('link', { name: 'See' }).first(),
        () => page.locator('a[href*="servers/edit"]').first(),
        () => page.locator('a').filter({ hasText: 'See' }).first(),
        () => page.locator('a[aria-label*="See"]').first()
    ];

    for (let i = 0; i < 10; i++) {
        for (const getLocator of strategies) {
            try {
                const loc = getLocator();
                if (await loc.isVisible({ timeout: 1500 })) {
                    await loc.click({ timeout: 5000 });
                    return true;
                }
            } catch (e) {}
        }
        await page.waitForTimeout(1200);
    }
    return false;
}

// ==================== 修复后的 getUsers ====================
function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && Array.isArray(parsed.users)) return parsed.users;
            console.log('[getUsers] USERS_JSON 格式错误，应为数组或 {users: [...]}');
            return [];
        }
    } catch (e) {
        console.error('解析 USERS_JSON 出错:', e.message);
        return [];
    }
    console.log('[getUsers] 未检测到 USERS_JSON 环境变量');
    return [];
}

async function checkProxy() { return true; } // 占位，需要可补充
function checkPort(p) { /* 占位 */ }
async function launchChrome() { /* 占位，保留你原来的 launchChrome 即可 */ }

// ==================== 主流程 ====================
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未找到用户，程序退出');
        process.exit(1);
    }

    if (PROXY_CONFIG && !(await checkProxy())) process.exit(1);
    await launchChrome();

    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch { await new Promise(r => setTimeout(r, 2000)); }
    }
    if (!browser) process.exit(1);

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG?.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    }

    await page.addInitScript(INJECTED_SCRIPT);

    // ==================== 开始录制视频 ====================
    const videoDir = path.join(process.cwd(), 'videos');
    if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
    await page.video.startRecording({ dir: videoDir, size: { width: 1280, height: 720 } });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const serverId = user.serverId || process.env.KATABUMP_SERVER_ID || '266194';
        console.log(`\n=== 处理用户 ${i + 1}/${users.length} (ServerID: ${serverId}) ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
                await page.video.startRecording({ dir: videoDir, size: { width: 1280, height: 720 } });
            }

            // 登录逻辑（保留你之前的登录流程 + Turnstile/ALTCHA）
            // ==================== 登录部分（省略相同代码） ====================
            // 这里保留你之前的登录 + Turnstile CDP 点击代码
            // ...

            // 找 See 按钮（已加固）
            console.log('正在寻找 See 按钮...');
            const seeSuccess = await findAndClickSeeButton(page);
            if (!seeSuccess) {
                console.log('   >> ❌ 多次尝试仍未找到 See 按钮，跳过当前用户');
                continue;
            }

            // Renew 流程（带 ALTCHA + Turnstile）
            // ...（保留你原来的 Renew 循环，把 Turnstile 部分换成 attemptTurnstileCdp + solveAltcha）

        } catch (err) {
            console.error('处理用户出错:', err);
        }

        // 保存截图
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        try {
            const pd = path.join(process.cwd(), 'screenshots');
            if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true });
            await page.screenshot({ path: path.join(pd, `${safeUser}.png`), fullPage: true });
        } catch (e) {}
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
