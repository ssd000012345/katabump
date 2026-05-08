const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/chrome_user_data';

chromium.use(stealth);

let proxyPool = []; // 存储筛选后的优质代理
let currentProxyIndex = -1; // -1 表示直连

// ==================== 代理池获取与测试 ====================

async function fetchAndTestProxies() {
    console.log('[代理池] 正在抓取免费代理并筛选最快的5个...');
    const urls = [
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
        'https://www.proxy-list.download/api/v1/get?type=http',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt'
    ];

    let rawProxies = [];
    for (const url of urls) {
        try {
            const res = await axios.get(url, { timeout: 5000 });
            rawProxies = rawProxies.concat(res.data.split(/\r?\n/).filter(p => p.includes(':')));
        } catch (e) {}
    }

    rawProxies = [...new Set(rawProxies)]; // 去重
    console.log(`[代理池] 共抓取到 ${rawProxies.length} 个候选代理，开始测速...`);

    const testTarget = 'https://dashboard.katabump.com/auth/login';
    const results = [];

    // 并发测试前 50 个代理（节省时间）
    const candidates = rawProxies.slice(0, 50);
    const promises = candidates.map(async (p) => {
        const [host, port] = p.trim().split(':');
        const start = Date.now();
        try {
            await axios.get(testTarget, { 
                proxy: { host, port: parseInt(port), protocol: 'http' },
                timeout: 5000 
            });
            results.push({ server: `http://${p.trim()}`, speed: Date.now() - start });
        } catch (e) {}
    });

    await Promise.allSettled(promises);
    proxyPool = results.sort((a, b) => a.speed - b.speed).slice(0, 5);
    
    if (proxyPool.length > 0) {
        console.log('[代理池] 最快的代理列表:');
        proxyPool.forEach((p, idx) => console.log(`   ${idx + 1}. ${p.server} (${p.speed}ms)`));
    } else {
        console.log('[代理池] ❌ 未找到可用代理，将仅使用直连。');
    }
}

// ==================== 系统控制 ====================

async function killChrome() {
    try {
        if (process.platform === 'win32') execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0');
        else execSync('pkill -9 chrome || true');
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
}

async function checkPort(p) { 
    return new Promise(r => { 
        const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); 
        req.on('error', () => r(false)); 
        req.end(); 
    }); 
}

async function launchChrome() {
    await killChrome();
    if (fs.existsSync(USER_DATA_DIR)) fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--user-data-dir=${USER_DATA_DIR}`,
        '--disable-gpu',
        '--window-size=1280,720',
        '--disable-dev-shm-usage',
        '--no-first-run'
    ];

    if (currentProxyIndex !== -1 && proxyPool[currentProxyIndex]) {
        const proxyServer = proxyPool[currentProxyIndex].server;
        console.log(`[启动] 模式：代理模式 (${proxyServer})`);
        args.push(`--proxy-server=${proxyServer}`, '--proxy-bypass-list=<-loopback>');
    } else {
        console.log('[启动] 模式：无代理直连');
    }

    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Chrome 启动失败');
}

// ==================== 验证码与业务逻辑 ====================

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

async function processSingleUser(user, browserInstance) {
    const context = browserInstance.contexts()[0];
    await context.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log(`[任务] 正在处理: ${user.username}`);
        // 关键：超时时间改为 30000ms
        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle', timeout: 30000 });
        
        await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
        await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
        for (let t = 0; t < 10; t++) { if (await attemptTurnstileCdp(page)) break; await page.waitForTimeout(1000); }
        await page.getByRole('button', { name: 'Login', exact: true }).click();
        await page.waitForTimeout(5000);

        if (page.url().includes('dashboard')) {
            console.log('   >> ✅ 登录成功');
            // 此处执行 Renew 逻辑...
            return true;
        }
    } catch (e) {
        console.error(`   >> ❌ 发生错误: ${e.message.split('\n')[0]}`);
    }
    return false;
}

// ==================== 主入口 ====================

(async () => {
    let users = [];
    try {
        const parsed = JSON.parse(process.env.USERS_JSON || '{}');
        users = parsed.users || (Array.isArray(parsed) ? parsed : []);
    } catch (e) { process.exit(1); }

    if (users.length === 0) process.exit(0);

    // 1. 获取代理池
    await fetchAndTestProxies();

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        let success = false;
        
        // 尝试队列：-1(直连) -> 0(代理1) -> 1(代理2)...
        const attemptSequence = [-1, ...Array.from(proxyPool.keys())];

        for (const proxyIdx of attemptSequence) {
            currentProxyIndex = proxyIdx;
            try {
                await launchChrome();
                const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
                success = await processSingleUser(user, browser);
                await browser.close();

                if (success) break; // 当前用户成功，跳过剩余代理尝试
                console.log(`   >> 模式 [${proxyIdx === -1 ? '直连' : '代理'}] 失败，尝试下一项...`);
            } catch (err) {
                console.log(`   >> 启动/连接异常: ${err.message}`);
            }
        }
        console.log(`[结果] 用户 ${user.username} -> ${success ? '成功' : '失败'}`);
    }
    process.exit(0);
})();
