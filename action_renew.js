const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const http = require('http');

// 环境变量配置
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/chrome_user_data';

// 代理配置解析
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
        console.log(`[系统] 代理配置已就绪: ${PROXY_CONFIG.server}`);
    } catch (e) { 
        console.error('[系统] 代理格式错误，请检查 HTTP_PROXY 环境变量'); 
    }
}

chromium.use(stealth);

// ==================== 核心控制逻辑 ====================

// 检查远程调试端口
async function checkPort(p) { 
    return new Promise(r => { 
        const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); 
        req.on('error', () => r(false)); 
        req.end(); 
    }); 
}

// 物理清理 Chrome 进程，防止端口占用
async function killChrome() {
    console.log('[系统] 正在清理旧的 Chrome 进程...');
    try {
        if (process.platform === 'win32') { 
            execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0'); 
        } else { 
            execSync('pkill -9 chrome || true'); 
        }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
}

// 测试代理连通性
async function checkProxy() {
    if (!PROXY_CONFIG) return false;
    try {
        const ac = { 
            proxy: { 
                protocol: 'http', 
                host: new URL(PROXY_CONFIG.server).hostname, 
                port: new URL(PROXY_CONFIG.server).port 
            }, 
            timeout: 10000 
        };
        if (PROXY_CONFIG.username) {
            ac.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', ac);
        return true;
    } catch (e) {
        console.error(`[系统] 代理测试失败: ${e.message}`);
        return false;
    }
}

// 启动 Chrome
async function launchChrome(useProxy = false) {
    await killChrome();
    
    // 清理数据目录，防止残留指纹和 Session
    if (fs.existsSync(USER_DATA_DIR)) {
        try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch(e) {}
    }

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--user-data-dir=${USER_DATA_DIR}`,
        '--disable-dev-shm-usage',
        '--lang=en-US',
        '--disable-blink-features=AutomationControlled'
    ];

    if (useProxy && PROXY_CONFIG) {
        console.log(`[启动] 模式：代理模式 (${PROXY_CONFIG.server})`);
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    } else {
        console.log('[启动] 模式：无代理直连');
    }

    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) {
            console.log(`[系统] Chrome 已在端口 ${DEBUG_PORT} 就绪`);
            return;
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Chrome 启动超时');
}

// ==================== 验证码处理逻辑 (原版注入) ====================

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
                await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                await client.detach(); return true;
            }

            const iframeElement = await frame.frameElement();
            if (!iframeElement) continue;
            const box = await iframeElement.boundingBox();
            if (!box) continue;
            const clickX = box.x + (box.width * data.xRatio);
            const clickY = box.y + (box.height * data.yRatio);
            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach(); return true;
        } catch (e) {}
    }
    return false;
}

async function hasAltchaWidget(page) { return await page.evaluate(() => !!document.querySelector('altcha-widget')); }
async function getAltchaState(page) {
    return await page.evaluate(() => {
        const w = document.querySelector('altcha-widget');
        if (!w) return null;
        const i = w.shadowRoot?.querySelector('.altcha');
        if (i) return i.getAttribute('data-state');
        return w.getAttribute('data-state');
    });
}
async function solveAltcha(page) {
    if (!(await hasAltchaWidget(page))) return false;
    try {
        const cb = page.locator('.altcha-checkbox').first();
        if (await cb.isVisible({ timeout: 2000 })) { await cb.click(); return true; }
    } catch (e) {}
    return false;
}

// 通用消息发送
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' });
    } catch (e) { console.error('[Telegram] 发送失败:', e.message); }
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        exec(cmd);
    }
}

// ==================== 业务逻辑 ====================

async function findAndClickSeeButton(page) {
    const strategies = [
        () => page.getByRole('link', { name: 'See' }).first(),
        () => page.locator('a[href*="servers/edit"]').first()
    ];
    for (let i = 0; i < 5; i++) {
        for (const s of strategies) {
            try {
                const l = s();
                if (await l.isVisible({ timeout: 1500 })) { await l.click(); return true; }
            } catch (e) {}
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

async function processSingleUser(user, browserInstance, shotDir) {
    const context = browserInstance.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');

    // GitHub 运行必须伪装 UA，否则会被 Cloudflare 标记
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log(`[任务] 正在处理: ${user.username}`);
        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle', timeout: 60000 });
        
        // 登录逻辑
        await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
        await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
        
        if (await hasAltchaWidget(page)) {
            await solveAltcha(page);
        } else {
            for (let t = 0; t < 10; t++) {
                if (await attemptTurnstileCdp(page)) break;
                await page.waitForTimeout(1000);
            }
        }
        
        await page.getByRole('button', { name: 'Login', exact: true }).click();
        await page.waitForTimeout(5000);

        if (!page.url().includes('dashboard')) {
            console.log('   >> 登录失败或卡在验证码。');
            return false;
        }

        console.log('   >> ✅ 登录成功');
        const seeOk = await findAndClickSeeButton(page);
        if (!seeOk) await page.goto(`https://dashboard.katabump.com/servers/edit?id=${user.serverId || '266194'}`);

        // Renew 逻辑
        const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
        if (await renewBtn.isVisible({ timeout: 5000 })) {
            await renewBtn.click();
            await page.waitForTimeout(2000);
            
            if (await hasAltchaWidget(page)) await solveAltcha(page);
            else await attemptTurnstileCdp(page);

            const confirm = page.locator('#renew-modal').getByRole('button', { name: 'Renew' });
            if (await confirm.isVisible()) {
                await confirm.click();
                await page.waitForTimeout(3000);
                console.log('   >> ✅ 续期指令已发送');
                await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}`);
            }
        } else {
            console.log('   >> ⏳ 暂无法续期或已续期');
        }

        return true;
    } catch (e) {
        console.error(`[用户错误] ${user.username}: ${e.message}`);
        return false;
    }
}

// ==================== 主程序 ====================

(async () => {
    let users = [];
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            users = Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) { console.error('USERS_JSON 解析失败'); process.exit(1); }

    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    // 第一阶段：直连尝试
    let currentProxyMode = false;
    await launchChrome(currentProxyMode);

    for (let i = 0; i < users.length; i++) {
        let browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
        let success = await processSingleUser(users[i], browser, shotDir);

        // 如果直连失败且有代理配置，则切换代理重试该用户
        if (!success && !currentProxyMode && PROXY_CONFIG) {
            console.log(`\n[降级] 用户 ${users[i].username} 处理失败，尝试测试并切换代理模式...`);
            if (await checkProxy()) {
                currentProxyMode = true;
                await launchChrome(true); // 重启为代理模式
                browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
                
                if (PROXY_CONFIG.username) {
                    await browser.contexts()[0].setHTTPCredentials({ 
                        username: PROXY_CONFIG.username, 
                        password: PROXY_CONFIG.password 
                    });
                }
                
                console.log(`[重试] 正在以代理模式重新处理: ${users[i].username}`);
                await processSingleUser(users[i], browser, shotDir);
            } else {
                console.log('[跳过] 代理不可用，无法重试。');
            }
        }
        await browser.close();
    }

    console.log('\n[完成] 所有任务已结束');
    process.exit(0);
})();
