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
        console.log(`[系统] 检测到代理配置: ${PROXY_CONFIG.server}`);
    } catch (e) { 
        console.error('[系统] 代理格式错误'); 
    }
}

chromium.use(stealth);

// ==================== 基础工具函数 ====================

async function checkPort(p) { 
    return new Promise(r => { 
        const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); 
        req.on('error', () => r(false)); 
        req.end(); 
    }); 
}

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

async function checkProxy() {
    if (!PROXY_CONFIG) return false;
    try {
        const ac = { 
            proxy: { host: new URL(PROXY_CONFIG.server).hostname, port: new URL(PROXY_CONFIG.server).port, protocol: 'http' }, 
            timeout: 10000 
        };
        if (PROXY_CONFIG.username) ac.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        await axios.get('https://www.google.com', ac);
        return true;
    } catch (e) {
        console.error(`[系统] 代理测试失败: ${e.message}`);
        return false;
    }
}

async function launchChrome(useProxy = false) {
    await killChrome();
    if (fs.existsSync(USER_DATA_DIR)) { 
        try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch(e) {} 
    }

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--user-data-dir=${USER_DATA_DIR}`,
        '--disable-gpu',
        '--window-size=1280,720',
        '--disable-dev-shm-usage',
        '--lang=en-US',
        '--no-first-run',
        '--no-default-browser-check'
    ];

    if (useProxy && PROXY_CONFIG) {
        console.log(`[启动] 模式：代理模式`);
        args.push(`--proxy-server=${PROXY_CONFIG.server}`, '--proxy-bypass-list=<-loopback>');
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
    throw new Error('Chrome 启动失败');
}

// ==================== 验证码点击逻辑 (保持原有逻辑) ====================

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
})();
`;

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (!data) continue;
            const iframeElement = await frame.frameElement();
            const box = iframeElement ? await iframeElement.boundingBox() : null;
            if (!box && frame !== page.mainFrame()) continue;
            
            const clickX = (box ? box.x : 0) + ((box ? box.width : page.viewportSize().width) * data.xRatio);
            const clickY = (box ? box.y : 0) + ((box ? box.height : page.viewportSize().height) * data.yRatio);
            
            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 100));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach(); return true;
        } catch (e) {}
    }
    return false;
}

// ==================== 业务逻辑 ====================

async function sendTelegramMessage(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' });
    } catch (e) { console.error('[TG] 发送失败'); }
}

async function processSingleUser(user, browserInstance) {
    const context = browserInstance.contexts()[0];
    
    // 【修复关键点】Playwright CDP 连接模式下设置 UA 的正确姿势
    await context.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log(`[任务] 正在处理: ${user.username}`);
        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle', timeout: 60000 });
        
        await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
        await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
        
        // 验证码尝试
        for (let t = 0; t < 10; t++) { if (await attemptTurnstileCdp(page)) break; await page.waitForTimeout(1000); }
        
        await page.getByRole('button', { name: 'Login', exact: true }).click();
        await page.waitForTimeout(5000);

        if (page.url().includes('dashboard')) {
            console.log('   >> ✅ 登录成功');
            // 此处可添加你原有的续期点击逻辑
            return true;
        }
        console.log('   >> ❌ 登录未成功，可能卡在验证码');
        return false;
    } catch (e) {
        console.error(`[错误] ${user.username}: ${e.message}`);
        return false;
    }
}

// ==================== 主入口 ====================

(async () => {
    let users = [];
    try {
        const parsed = JSON.parse(process.env.USERS_JSON || '{}');
        users = Array.isArray(parsed) ? parsed : (parsed.users || []);
    } catch (e) { console.error('USERS_JSON 解析失败'); process.exit(1); }

    if (users.length === 0) { console.log('没有待处理的用户'); process.exit(0); }

    let useProxy = false;
    await launchChrome(useProxy);

    for (let i = 0; i < users.length; i++) {
        let browser;
        for(let attempt=0; attempt<3; attempt++) {
            try {
                browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
                break;
            } catch(e) { await new Promise(r => setTimeout(r, 2000)); }
        }
        
        if (!browser) continue;

        let success = await processSingleUser(users[i], browser);

        // 如果直连失败，且有代理配置，则切换代理重试
        if (!success && !useProxy && PROXY_CONFIG) {
            console.log(`\n[重试] 用户 ${users[i].username} 直连失败，正在尝试切换代理模式...`);
            if (await checkProxy()) {
                useProxy = true;
                await browser.close().catch(() => {});
                await launchChrome(true); // 以代理模式重新启动
                
                browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
                const context = browser.contexts()[0];
                if (PROXY_CONFIG.username) {
                    await context.setHTTPCredentials({ 
                        username: PROXY_CONFIG.username, 
                        password: PROXY_CONFIG.password 
                    });
                }
                success = await processSingleUser(users[i], browser);
            }
        }
        
        await browser.close().catch(() => {});
        console.log(`[结束] 用户 ${users[i].username} 处理结果: ${success ? '成功' : '失败'}`);
    }

    process.exit(0);
})();
