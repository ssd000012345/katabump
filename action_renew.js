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

// ==================== 1. 代理池：自动化抓取、存活校验与测速 ====================

async function fetchAndTestProxies() {
    console.log('[代理池] 正在从多个源抓取免费代理...');
    const sources = [
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'
    ];

    let rawList = [];
    for (const url of sources) {
        try {
            const res = await axios.get(url, { timeout: 10000 });
            const found = res.data.split('\n').filter(line => line.includes(':'));
            rawList = rawList.concat(found);
        } catch (e) {}
    }

    rawList = [...new Set(rawList.map(s => s.trim()))];
    console.log(`[代理池] 抓取到 ${rawList.length} 个候选。开始深度测速筛选...`);

    const testTarget = 'https://dashboard.katabump.com/auth/login';
    const activeResults = [];
    
    // 并发测试前 100 个代理，筛选真正能打开页面的
    const tasks = rawList.slice(0, 100).map(async (p) => {
        const [host, port] = p.split(':');
        const start = Date.now();
        try {
            await axios.get(testTarget, { 
                proxy: { host, port: parseInt(port), protocol: 'http' },
                timeout: 5000 // 5秒内必须有响应
            });
            activeResults.push({ server: `http://${p}`, speed: Date.now() - start });
        } catch (e) {}
    });

    await Promise.allSettled(tasks);
    
    // 取最快的前 5 个
    proxyPool = activeResults.sort((a, b) => a.speed - b.speed).slice(0, 5);
    
    if (proxyPool.length > 0) {
        console.log(`[代理池] 成功锁定 5 个极速代理:`);
        proxyPool.forEach((p, i) => console.log(`   ${i+1}. ${p.server} (${p.speed}ms)`));
    } else {
        console.log('[代理池] ⚠️ 未找到优质代理，将依赖本地网络。');
    }
}

// ==================== 2. 环境管理 ====================

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
        '--lang=en-US',
        '--no-first-run'
    ];

    if (useProxyIndex !== -1 && proxyPool[useProxyIndex]) {
        console.log(`[启动] 模式：代理模式 -> ${proxyPool[useProxyIndex].server}`);
        args.push(`--proxy-server=${proxyPool[useProxyIndex].server}`, '--proxy-bypass-list=<-loopback>');
    } else {
        console.log('[启动] 模式：直连模式');
    }

    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('浏览器启动超时');
}

// ==================== 3. 登录与续期逻辑 ====================

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
            await new Promise(r => setTimeout(r, 100));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await client.detach(); return true;
        } catch (e) {}
    }
    return false;
}

async function processUser(user, browser) {
    const context = browser.contexts()[0];
    // 修复点：正确设置 User-Agent
    await context.setExtraHTTPHeaders({ 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' 
    });
    
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log(`   [执行] 账号: ${user.username}`);
        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle', timeout: 30000 });
        
        await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
        await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
        
        for (let t = 0; t < 10; t++) { if (await attemptTurnstileCdp(page)) break; await page.waitForTimeout(1000); }
        
        await page.getByRole('button', { name: 'Login', exact: true }).click();
        await page.waitForTimeout(5000);

        if (page.url().includes('dashboard')) {
            console.log('      >> ✅ 登录成功');
            // ...在此处保留原有的 Renew 点击逻辑...
            return true;
        }
    } catch (e) {
        console.log(`      >> ❌ 连接失败: ${e.message.split('\n')[0]}`);
    }
    return false;
}

// ==================== 4. 主入口 ====================

(async () => {
    let users = [];
    try {
        const parsed = JSON.parse(process.env.USERS_JSON || '{}');
        users = parsed.users || (Array.isArray(parsed) ? parsed : []);
    } catch (e) { process.exit(1); }

    if (users.length === 0) process.exit(0);

    // 第一步：抓取并测速筛选代理
    await fetchAndTestProxies();

    for (const user of users) {
        let success = false;
        // 轮换策略：直连 -> 代理1 -> 代理2 ...
        const attempts = [-1, ...Array.from(proxyPool.keys())];

        for (const modeIndex of attempts) {
            try {
                await launchChrome(modeIndex);
                const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
                success = await processUser(user, browser);
                await browser.close().catch(() => {});
                
                if (success) break;
                console.log(`      >> 切换下一模式重试...`);
            } catch (e) { console.log(`      >> 异常: ${e.message}`); }
        }
        console.log(`[结果] 账号 ${user.username} 处理${success ? '完成' : '失败'}`);
    }
    process.exit(0);
})();
