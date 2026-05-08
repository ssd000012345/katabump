const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const USER_DATA_DIR = '/tmp/chrome_user_data';

chromium.use(stealth);

let proxyPool = []; 

// ==================== 1. 代理池：严选与测速 ====================

async function fetchAndTestProxies() {
    console.log('[代理池] 正在抓取并严选最快代理...');
    const sources = [
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'
    ];

    let rawList = [];
    for (const url of sources) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            const found = res.data.split('\n').filter(line => line.includes(':'));
            rawList = rawList.concat(found);
        } catch (e) {}
    }

    rawList = [...new Set(rawList.map(s => s.trim()))];
    console.log(`[代理池] 抓取到 ${rawList.length} 个候选。开始测速筛选（限时 30s）...`);

    const testTarget = 'https://dashboard.katabump.com/auth/login';
    const activeResults = [];
    
    // 并发测试前 80 个代理
    const tasks = rawList.slice(0, 80).map(async (p) => {
        const [host, port] = p.split(':');
        const start = Date.now();
        try {
            // 严选标准：必须能连通目标登录页，且响应在 6 秒内
            await axios.get(testTarget, { 
                proxy: { host, port: parseInt(port), protocol: 'http' },
                timeout: 6000 
            });
            activeResults.push({ server: `http://${p}`, speed: Date.now() - start });
        } catch (e) {}
    });

    await Promise.allSettled(tasks);
    
    // 按速度排序，只取前 5 个最快的
    proxyPool = activeResults.sort((a, b) => a.speed - b.speed).slice(0, 5);
    
    if (proxyPool.length > 0) {
        console.log(`[代理池] 筛选完成，已锁定最快 5 个可用代理:`);
        proxyPool.forEach((p, i) => console.log(`   ${i+1}. ${p.server} (${p.speed}ms)`));
    } else {
        console.log('[代理池] ❌ 未找到极速代理，将使用直连尝试。');
    }
}

// ==================== 2. 环境控制 ====================

async function killChrome() {
    try {
        if (process.platform === 'win32') execSync('taskkill /F /IM chrome.exe /T 2>nul || exit 0');
        else execSync('pkill -9 chrome || true');
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
}

function checkPort(p) { 
    return new Promise(r => { 
        const req = http.get(`http://localhost:${p}/json/version`, () => r(true)); 
        req.on('error', () => r(false)); 
        req.end(); 
    }); 
}

async function launchChrome(useProxyIndex = -1) {
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
        '--lang=en-US'
    ];

    if (useProxyIndex !== -1 && proxyPool[useProxyIndex]) {
        console.log(`[启动] 模式：代理直连模式 (${proxyPool[useProxyIndex].server})`);
        args.push(`--proxy-server=${proxyPool[useProxyIndex].server}`, '--proxy-bypass-list=<-loopback>');
    } else {
        console.log('[启动] 模式：本地网络直连');
    }

    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Chrome 启动超时');
}

// ==================== 3. 核心业务与验证码逻辑 ====================

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
            await new Promise(r => setTimeout(r, 120));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach(); return true;
        } catch (e) {}
    }
    return false;
}

async function processUser(user, browser) {
    const context = browser.contexts()[0];
    // 正确设置 User-Agent，避免 TypeError
    await context.setExtraHTTPHeaders({ 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' 
    });
    
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log(`   [任务] 正在处理: ${user.username}`);
        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle', timeout: 30000 });
        
        await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
        await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
        
        // 处理验证码
        for (let t = 0; t < 12; t++) { if (await attemptTurnstileCdp(page)) break; await page.waitForTimeout(1000); }
        
        await page.getByRole('button', { name: 'Login', exact: true }).click();
        await page.waitForTimeout(6000);

        if (page.url().includes('dashboard')) {
            console.log('      >> ✅ 登录成功');
            // 此处可以继续执行你原有的 Renew 续期点击逻辑
            return true;
        }
    } catch (e) {
        console.log(`      >> ❌ 超时或连接错误: ${e.message.split('\n')[0]}`);
    }
    return false;
}

// ==================== 4. 主程序：账号与代理轮换逻辑 ====================

(async () => {
    let users = [];
    try {
        const parsed = JSON.parse(process.env.USERS_JSON || '{}');
        users = parsed.users || (Array.isArray(parsed) ? parsed : []);
    } catch (e) { console.error('JSON格式错误'); process.exit(1); }

    if (users.length === 0) process.exit(0);

    // 步骤1：严选代理池
    await fetchAndTestProxies();

    for (const user of users) {
        let success = false;
        // 尝试队列：无代理直连 -> 代理1 -> 代理2 ... 直到成功
        const modes = [-1, ...Array.from(proxyPool.keys())];

        for (const modeIndex of modes) {
            try {
                await launchChrome(modeIndex);
                const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
                success = await processUser(user, browser);
                await browser.close().catch(() => {});
                
                if (success) break; // 成功则跳出代理循环，处理下一个账号
                console.log(`      >> [模式切换] 尝试下一个代理...`);
            } catch (e) {
                console.log(`      >> [运行异常] ${e.message}`);
            }
        }
        console.log(`[账号结果] ${user.username} -> ${success ? '✅ 成功' : '❌ 失败'}`);
    }
    process.exit(0);
})();
