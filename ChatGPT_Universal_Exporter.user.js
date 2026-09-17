// ==UserScript==
// @name         ChatGPT Universal Exporter (Markdown Support, Selective + Retry Failed)
// @version      1.0.9-selective-retry-failed
// @description  User-centric ZIP exporter with multi-ID support. Supports JSON & Markdown formats. Based on ChatGPT Universal Exporter.
// @author       huhu
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @license      MIT
// @source       https://greasyfork.org/scripts/538495-chatgpt-universal-exporter
// @namespace    https://github.com/huhusmang/ChatGPT-Exporter
// @downloadURL https://update.greasyfork.org/scripts/556233/ChatGPT%20Universal%20Exporter%20%28Markdown%20Support%29.user.js
// @updateURL https://update.greasyfork.org/scripts/556233/ChatGPT%20Universal%20Exporter%20%28Markdown%20Support%29.meta.js
// ==/UserScript==

/* ============================================================
    v1.0.0 变更 (基于原始脚本的Markdown支持增强版)
    ------------------------------------------------------------
    • 增加了 Markdown 格式导出支持
    • 保持了原有的 JSON 导出功能
    ========================================================== */

(function () {
    'use strict';

    // --- 配置与全局变量 ---
    // --- 限速配置 ---
    // Fast Retry：正常抓取接近原脚本速度，只保留短随机间隔。
    // 只有遇到 429 / Too many requests / 5xx 临时错误时，才进入长等待并重试。
    const LIST_DELAY_MIN = 500;
    const LIST_DELAY_MAX = 1200;
    const DETAIL_DELAY_MIN = 800;
    const DETAIL_DELAY_MAX = 1800;
    const RATE_LIMIT_FALLBACK_MS = 150000; // 429 且服务端没给 Retry-After 时，默认等 2 分钟
    const MAX_RETRIES = 7;
    const PAGE_LIMIT = 100; // 从 100 降到 50，减轻列表接口压力
    const LONG_COOLDOWN_EVERY = 0; // 每抓 N 个详情，主动长休息一次
    const LONG_COOLDOWN_MS = 0;

    let accessToken = null;
    let capturedWorkspaceIds = new Set(); // 使用Set存储网络拦截到的ID，确保唯一性
    const conversationMetaById = new Map(); // 记录 id -> 标题/更新时间/来源，用于失败清单

    // --- 核心：网络拦截与信息捕获 ---
    (function interceptNetwork() {
        const rawFetch = window.fetch;
        window.fetch = async function (resource, options) {
            tryCaptureToken(options?.headers);
            if (options?.headers?.['ChatGPT-Account-Id']) {
                const id = options.headers['ChatGPT-Account-Id'];
                if (id && !capturedWorkspaceIds.has(id)) {
                    console.log('🎯 [Fetch] 捕获到 Workspace ID:', id);
                    capturedWorkspaceIds.add(id);
                }
            }
            return rawFetch.apply(this, arguments);
        };

        const rawOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () {
            this.addEventListener('readystatechange', () => {
                if (this.readyState === 4) {
                    try {
                        tryCaptureToken(this.getRequestHeader('Authorization'));
                        const id = this.getRequestHeader('ChatGPT-Account-Id');
                        if (id && !capturedWorkspaceIds.has(id)) {
                            console.log('🎯 [XHR] 捕获到 Workspace ID:', id);
                            capturedWorkspaceIds.add(id);
                        }
                    } catch (_) {}
                }
            });
            return rawOpen.apply(this, arguments);
        };
    })();

    function tryCaptureToken(header) {
        if (!header) return;
        const h = typeof header === 'string' ? header : header instanceof Headers ? header.get('Authorization') : header.Authorization || header.authorization;
        if (h?.startsWith('Bearer ')) {
        const token = h.slice(7);
        // [v8.2.0 修复] 在捕获源头增加验证，拒绝已知的无效占位符Token
        if (token && token.toLowerCase() !== 'dummy') {
            accessToken = token;
        }
        }
    }

    async function ensureAccessToken() {
        if (accessToken) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session.accessToken) {
                accessToken = session.accessToken;
                return accessToken;
            }
        } catch (_) {}
        alert('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
        return null;
    }

    // --- 辅助函数 ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const randomBetween = (min, max) => min + Math.random() * (max - min);
    const listJitter = () => randomBetween(LIST_DELAY_MIN, LIST_DELAY_MAX);
    const detailJitter = () => randomBetween(DETAIL_DELAY_MIN, DETAIL_DELAY_MAX);
    const sanitizeFilename = (name) => name.replace(/[\/\\?%*:|"<>]/g, '-').trim();

    function rememberConversationMeta(item, extra = {}) {
        if (!item?.id) return;
        const old = conversationMetaById.get(item.id) || {};
        conversationMetaById.set(item.id, {
            id: item.id,
            title: item.title || old.title || 'Untitled Conversation',
            update_time: item.update_time || item.updated_at || item.create_time || item.created_at || old.update_time || null,
            is_archived: typeof extra.is_archived === 'boolean' ? extra.is_archived : old.is_archived,
            source: extra.source || old.source || '历史列表',
            project_title: extra.project_title || old.project_title || null
        });
    }

    function getConversationMeta(id) {
        return conversationMetaById.get(id) || {
            id,
            title: 'Unknown title',
            update_time: null,
            source: '未知来源',
            project_title: null
        };
    }

    function buildConversationUrl(id) {
        try {
            return `${location.origin}/c/${id}`;
        } catch (_) {
            return `https://chatgpt.com/c/${id}`;
        }
    }

    function renderFailuresMarkdown(failures) {
        const lines = ['# Export Failures', ''];
        lines.push(`Total failures: ${failures.length}`);
        lines.push('');
        failures.forEach((f, index) => {
            lines.push(`## ${index + 1}. ${f.title || 'Unknown title'}`);
            lines.push('');
            lines.push(`- ID: \`${f.id}\``);
            lines.push(`- Label: ${f.label || ''}`);
            lines.push(`- Source: ${f.source || 'unknown'}`);
            if (f.project_title) lines.push(`- Project: ${f.project_title}`);
            if (f.update_time) lines.push(`- Updated: ${f.update_time}`);
            lines.push(`- Error: ${f.error}`);
            lines.push(`- Failed at: ${f.failed_at}`);
            lines.push(`- Open: ${f.url}`);
            lines.push('');
        });
        return lines.join('\n');
    }


    function parseRetryAfterMs(headers) {
        const value = headers?.get?.('Retry-After');
        if (!value) return null;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const dateMs = Date.parse(value);
        if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
        return null;
    }

    async function fetchJsonWithRetry(url, options = {}, label = 'request') {
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const r = await fetch(url, options);

                if (r.ok) {
                    return await r.json();
                }

                const retryable = r.status === 429 || [500, 502, 503, 504].includes(r.status);
                if (!retryable) {
                    const body = await r.text().catch(() => '');
                    throw new Error(`${label} 失败 (${r.status}) ${body.slice(0, 300)}`);
                }

                const retryAfterMs = parseRetryAfterMs(r.headers);
                const backoffMs = retryAfterMs ?? (
                    r.status === 429
                        ? RATE_LIMIT_FALLBACK_MS + randomBetween(0, 60000)
                        : Math.min(300000, 15000 * Math.pow(2, attempt - 1) + randomBetween(0, 15000))
                );

                console.warn(`⏳ ${label} 触发限速/临时错误 HTTP ${r.status}${r.status === 429 ? ' / Too many requests' : ''}，第 ${attempt}/${MAX_RETRIES} 次，等待 ${Math.round(backoffMs / 1000)} 秒后重试:`, url);
                await sleep(backoffMs);
                lastError = new Error(`${label} HTTP ${r.status}`);
            } catch (e) {
                lastError = e;

                if (attempt >= MAX_RETRIES) break;

                const backoffMs = Math.min(300000, 15000 * Math.pow(2, attempt - 1) + randomBetween(0, 15000));
                console.warn(`⏳ ${label} 请求异常，第 ${attempt}/${MAX_RETRIES} 次，等待 ${Math.round(backoffMs / 1000)} 秒后重试:`, e);
                await sleep(backoffMs);
            }
        }

        throw lastError || new Error(`${label} 多次重试后失败`);
    }

    /**
     * [新增] 从Cookie中获取 oai-device-id
     * @returns {string|null} - 返回设备ID或null
     */
    function getOaiDeviceId() {
        const cookieString = document.cookie;
        const match = cookieString.match(/oai-did=([^;]+)/);
        return match ? match[1] : null;
    }

    function generateUniqueFilename(convData) {
        const convId = convData.conversation_id || '';
        const shortId = convId.includes('-') ? convId.split('-').pop() : (convId || Date.now().toString(36));
        let baseName = convData.title;
        if (!baseName || baseName.trim().toLowerCase() === 'new chat') {
            baseName = 'Untitled Conversation';
        }
        return `${sanitizeFilename(baseName)}_${shortId}.json`;
    }

    function generateMarkdownFilename(convData) {
        const jsonName = generateUniqueFilename(convData);
        return jsonName.endsWith('.json')
            ? `${jsonName.slice(0, -5)}.md`
            : `${jsonName}.md`;
    }

    function cleanMessageContent(text) {
        if (!text) return '';
        return text
            .replace(/\uE200cite(?:\uE202turn\d+(?:search|view)\d+)+\uE201/gi, '')
            .replace(/cite(?:turn\d+(?:search|view)\d+)+/gi, '')
            .trim();
    }

    function extractConversationMessages(convData) {
        const mapping = convData?.mapping;
        if (!mapping) return [];

        const messages = [];
        const mappingKeys = Object.keys(mapping);
        const rootId = mapping['client-created-root']
            ? 'client-created-root'
            : mappingKeys.find(id => !mapping[id]?.parent) || mappingKeys[0];
        const visited = new Set();

        const traverse = (nodeId) => {
            if (!nodeId || visited.has(nodeId)) return;
            visited.add(nodeId);
            const node = mapping[nodeId];
            if (!node) return;

            const msg = node.message;
            if (msg) {
                const author = msg.author?.role;
                const isHidden = msg.metadata?.is_visually_hidden_from_conversation ||
                    msg.metadata?.is_contextual_answers_system_message;
                if (author && author !== 'system' && !isHidden) {
                    const content = msg.content;
                    if (content?.content_type === 'text' && Array.isArray(content.parts)) {
                        const rawText = content.parts
                            .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
                            .filter(Boolean)
                            .join('\n');
                        const cleaned = cleanMessageContent(rawText);
                        if (cleaned) {
                            messages.push({
                                role: author,
                                content: cleaned,
                                create_time: msg.create_time || null
                            });
                        }
                    }
                }
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(childId => traverse(childId));
            }
        };

        if (rootId) {
            traverse(rootId);
        } else {
            mappingKeys.forEach(traverse);
        }

        return messages;
    }

    function convertConversationToMarkdown(convData) {
        const messages = extractConversationMessages(convData);
        if (messages.length === 0) {
            return '# Conversation\nNo visible user or assistant messages were exported.\n';
        }

        const mdLines = [];
        messages.forEach(msg => {
            const roleLabel = msg.role === 'user' ? '# User' : '# Assistant';
            mdLines.push(roleLabel);
            mdLines.push(msg.content);
            mdLines.push('');
        });

        return mdLines.join('\n').trim() + '\n';
    }

    function downloadFile(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    // --- 导出流程核心逻辑 ---
    function getExportButton() {
        let btn = document.getElementById('gpt-rescue-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'gpt-rescue-btn';
            btn.style.display = 'none';
            btn.textContent = 'Export Conversations';
            document.body.appendChild(btn);
        }
        return btn;
    }

    async function startExportProcess(mode, workspaceId) {
        const btn = getExportButton();
        btn.disabled = true;

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
            return;
        }

        try {
            const zip = new JSZip();
            const conversationCache = new Map(); // 同一条对话在普通列表和项目列表重复出现时，不再重复请求详情
            const failures = [];
            let detailFetchCount = 0;

            async function exportConversationToFolder(convId, folder, label) {
                try {
                    let convData = conversationCache.get(convId);

                    if (!convData) {
                        convData = await getConversation(convId, workspaceId);
                        conversationCache.set(convId, convData);
                        detailFetchCount++;

                        if (LONG_COOLDOWN_EVERY > 0 && detailFetchCount > 0 && detailFetchCount % LONG_COOLDOWN_EVERY === 0) {
                            btn.textContent = `☕ 主动冷却 ${Math.round(LONG_COOLDOWN_MS / 1000)}s，已抓取 ${detailFetchCount} 条`;
                            await sleep(LONG_COOLDOWN_MS);
                        }
                    }

                    folder.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
                    folder.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData));
                    return true;
                } catch (e) {
                    console.error(`❌ 导出失败: ${label} / ${convId}`, e);
                    const meta = getConversationMeta(convId);
                    failures.push({
                        id: convId,
                        title: meta.title,
                        label,
                        source: meta.source,
                        project_title: meta.project_title,
                        update_time: meta.update_time,
                        url: buildConversationUrl(convId),
                        error: e?.message || String(e),
                        failed_at: new Date().toISOString()
                    });
                    return false;
                }
            }

            btn.textContent = '📂 获取普通历史对话列表…';
            const orphanIds = await collectIds(btn, workspaceId, null);
            for (let i = 0; i < orphanIds.length; i++) {
                btn.textContent = `📥 普通历史 (${i + 1}/${orphanIds.length})`;
                await exportConversationToFolder(orphanIds[i], zip, `普通历史 ${i + 1}/${orphanIds.length}`);
                await sleep(detailJitter());
            }

            btn.textContent = '🔍 获取项目列表…';
            const projects = await getProjects(workspaceId);
            for (const project of projects) {
                const projectFolder = zip.folder(sanitizeFilename(project.title));
                btn.textContent = `📂 项目: ${project.title}`;
                const projectConvIds = await collectIds(btn, workspaceId, project.id);
                projectConvIds.forEach(id => {
                    const meta = getConversationMeta(id);
                    conversationMetaById.set(id, {
                        ...meta,
                        source: '项目列表',
                        project_title: project.title
                    });
                });
                if (projectConvIds.length === 0) continue;

                for (let i = 0; i < projectConvIds.length; i++) {
                    btn.textContent = `📥 ${project.title.substring(0,10)}... (${i + 1}/${projectConvIds.length})`;
                    await exportConversationToFolder(projectConvIds[i], projectFolder, `项目 ${project.title} ${i + 1}/${projectConvIds.length}`);
                    await sleep(detailJitter());
                }
            }

            if (failures.length > 0) {
                zip.file('_export_failures.json', JSON.stringify(failures, null, 2));
                zip.file('_export_failures.md', renderFailuresMarkdown(failures));
            }

            btn.textContent = '📦 生成 ZIP 文件…';
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const filename = mode === 'team'
                ? `chatgpt_team_backup_${workspaceId}_${date}.zip`
                : `chatgpt_personal_backup_${date}.zip`;
            downloadFile(blob, filename);

            if (failures.length > 0) {
                alert(`⚠️ 导出完成，但有 ${failures.length} 条对话多次重试后仍失败。失败标题、ID、链接已写入 _export_failures.md / _export_failures.json。建议休息 10~30 分钟后单独补导失败项。`);
                btn.textContent = `⚠️ 完成，失败 ${failures.length} 条`;
            } else {
                alert(`✅ 导出完成！`);
                btn.textContent = '✅ 完成';
            }

        } catch (e) {
            console.error("导出过程中发生严重错误:", e);
            alert(`导出失败: ${e.message}。详情请查看控制台（F12 -> Console）。`);
            btn.textContent = '⚠️ Error';
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Export Conversations';
            }, 3000);
        }
    }

    function startScheduledExport(options = {}) {
        const { mode = 'personal', workspaceId = null, autoConfirm = false, source = 'schedule' } = options;
        const proceed = async () => {
            try {
                await startExportProcess(mode, workspaceId);
            } catch (err) {
                console.error('[ChatGPT Exporter] 自动导出失败:', err);
            }
        };

        if (autoConfirm) {
            proceed();
            return;
        }

        const modeLabel = mode === 'team' ? '团队空间' : '个人空间';
        if (confirm(`Chrome 扩展请求导出 ${modeLabel} 对话（来源: ${source}）。是否开始？`)) {
            proceed();
        }
    }

    // --- API 调用函数 ---
    async function getProjects(workspaceId) {
        if (!workspaceId) return [];
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'ChatGPT-Account-Id': workspaceId,
            'oai-device-id': deviceId
        };
        let data;
        try {
            data = await fetchJsonWithRetry(`/backend-api/gizmos/snorlax/sidebar`, { headers }, '获取项目列表');
        } catch (e) {
            console.warn(`获取项目(Gizmo)列表失败`, e);
            return [];
        }
        const projects = [];
        data.items?.forEach(item => {
            if (item?.gizmo?.id && item?.gizmo?.display?.name) {
                projects.push({ id: item.gizmo.id, title: item.gizmo.display.name });
            }
        });
        return projects;
    }

    async function collectIds(btn, workspaceId, gizmoId) {
        const all = new Set();
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        if (gizmoId) {
            let cursor = '0';
            do {
                const j = await fetchJsonWithRetry(`/backend-api/gizmos/${gizmoId}/conversations?cursor=${cursor}`, { headers }, '列举项目对话列表');
                j.items?.forEach(it => {
                    all.add(it.id);
                    rememberConversationMeta(it, { source: '项目列表', project_title: gizmoId });
                });
                cursor = j.cursor;
                await sleep(listJitter());
            } while (cursor);
        } else {
            for (const is_archived of [false, true]) {
                let offset = 0, has_more = true, page = 0;
                do {
                    btn.textContent = `📂 项目外对话 (${is_archived ? 'Archived' : 'Active'} p${++page})`;
                    const j = await fetchJsonWithRetry(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers }, '列举普通历史对话列表');
                    if (j.items && j.items.length > 0) {
                        j.items.forEach(it => {
                            all.add(it.id);
                            rememberConversationMeta(it, { source: is_archived ? '普通历史/Archived' : '普通历史/Active', is_archived });
                        });
                        has_more = j.items.length === PAGE_LIMIT;
                        offset += j.items.length;
                    } else {
                        has_more = false;
                    }
                    await sleep(listJitter());
                } while (has_more);
            }
        }
        return Array.from(all);
    }

    async function getConversation(id, workspaceId) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }
        const j = await fetchJsonWithRetry(`/backend-api/conversation/${id}`, { headers }, `获取对话详情 conv ${id}`);
        j.__fetched_at = new Date().toISOString();
        return j;
    }

    // --- UI 相关函数 ---
    // (UI部分无变动，此处省略以保持简洁)
    /**
     * [新增] 全面检测函数，返回所有找到的ID
     * @returns {string[]} - 返回包含所有唯一Workspace ID的数组
     */
    function detectAllWorkspaceIds() {
        const foundIds = new Set(capturedWorkspaceIds); // 从网络拦截的结果开始

        // 扫描 __NEXT_DATA__
        try {
            const data = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
            // 遍历所有账户信息
            const accounts = data?.props?.pageProps?.user?.accounts;
            if (accounts) {
                Object.values(accounts).forEach(acc => {
                    if (acc?.account?.id) {
                        foundIds.add(acc.account.id);
                    }
                });
            }
        } catch (e) {}

        // 扫描 localStorage
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('account') || key.includes('workspace'))) {
                    const value = localStorage.getItem(key);
                    if (value && /^[a-z0-9]{2,}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         const extractedId = value.match(/ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
                         if(extractedId) foundIds.add(extractedId[0]);
                    } else if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         foundIds.add(value.replace(/"/g, ''));
                    }
                }
            }
        } catch(e) {}

        console.log('🔍 检测到以下 Workspace IDs:', Array.from(foundIds));
        return Array.from(foundIds);
    }

    /**
     * [重构] 多步骤、用户主导的导出对话框
     */

    function extractConversationIdsFromText(text) {
        const ids = new Set();
        if (!text) return [];

        // ChatGPT conversation IDs usually appear in URLs like /c/<uuid>,
        // or in exported failure JSON as id fields.
        const urlMatches = text.matchAll(/\/c\/([a-zA-Z0-9_-]{8,})/g);
        for (const m of urlMatches) ids.add(m[1]);

        const jsonIdMatches = text.matchAll(/"id"\s*:\s*"([^"]{8,})"/g);
        for (const m of jsonIdMatches) ids.add(m[1]);

        // Also accept pasted bare UUID-like or short-id-like strings.
        const looseMatches = text.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{20,})\b/g);
        for (const m of looseMatches) ids.add(m[1]);

        return Array.from(ids);
    }

    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
            reader.readAsText(file);
        });
    }

    function showRetryFailedDialog(options = {}) {
        const { mode = 'personal', workspaceId = null } = options;

        return new Promise(resolve => {
            const old = document.getElementById('retry-failed-dialog-overlay');
            if (old) old.remove();

            const overlay = document.createElement('div');
            overlay.id = 'retry-failed-dialog-overlay';
            Object.assign(overlay.style, {
                position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                backgroundColor: 'rgba(0,0,0,.5)', zIndex: '100000',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
            });

            const dialog = document.createElement('div');
            Object.assign(dialog.style, {
                background: '#fff', color: '#111', width: '680px', maxWidth: '92vw',
                borderRadius: '12px', boxShadow: '0 12px 40px rgba(0,0,0,.25)',
                padding: '18px', boxSizing: 'border-box', fontFamily: 'Arial, sans-serif'
            });

            dialog.innerHTML = `
                <div style="font-size:18px;font-weight:700;margin-bottom:8px;">补抓指定对话 / 失败项</div>
                <div style="font-size:13px;color:#555;margin-bottom:12px;line-height:1.5;">
                    可以粘贴 <code>https://chatgpt.com/c/...</code> 链接、conversation id，或者选择上次导出的 <code>_export_failures.json</code>。
                    本功能只抓这些 ID，不会重新全量导出。
                </div>

                <textarea id="retry-failed-input" placeholder="把失败链接、conversation id，或 _export_failures.json 内容粘贴到这里..."
                    style="width:100%;height:220px;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-family:monospace;font-size:12px;"></textarea>

                <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;">
                    <input id="retry-failed-file" type="file" accept=".json,.md,.txt" style="font-size:13px;">
                    <button id="retry-failed-parse-btn" style="padding:8px 10px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">解析数量</button>
                    <span id="retry-failed-status" style="font-size:13px;color:#444;">尚未解析</span>
                </div>

                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
                    <button id="retry-failed-cancel-btn" style="padding:10px 14px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">取消</button>
                    <button id="retry-failed-start-btn" style="padding:10px 14px;border:none;border-radius:8px;background:#10a37f;color:#fff;font-weight:700;cursor:pointer;">开始补抓</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const input = dialog.querySelector('#retry-failed-input');
            const fileInput = dialog.querySelector('#retry-failed-file');
            const status = dialog.querySelector('#retry-failed-status');

            async function collectInputText() {
                let text = input.value || '';
                const file = fileInput.files?.[0];
                if (file) {
                    const fileText = await readFileAsText(file);
                    text += '\n' + fileText;
                }
                return text;
            }

            async function updateStatus() {
                try {
                    const text = await collectInputText();
                    const ids = extractConversationIdsFromText(text);
                    status.textContent = `已解析到 ${ids.length} 个唯一对话 ID`;
                    return ids;
                } catch (e) {
                    status.textContent = `解析失败: ${e.message}`;
                    return [];
                }
            }

            dialog.querySelector('#retry-failed-parse-btn').onclick = updateStatus;
            fileInput.onchange = updateStatus;
            input.oninput = () => {
                const ids = extractConversationIdsFromText(input.value || '');
                status.textContent = `当前文本中解析到 ${ids.length} 个唯一对话 ID`;
            };

            dialog.querySelector('#retry-failed-cancel-btn').onclick = () => {
                overlay.remove();
                resolve(null);
            };

            dialog.querySelector('#retry-failed-start-btn').onclick = async () => {
                const ids = await updateStatus();
                if (!ids.length) {
                    alert('没有解析到可补抓的 conversation id。');
                    return;
                }
                overlay.remove();
                resolve(ids);
            };

            overlay.onclick = e => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve(null);
                }
            };
        });
    }

    async function startRetryFailedExportProcess(mode, workspaceId) {
        const btn = getExportButton();
        btn.disabled = true;

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
            return;
        }

        try {
            const ids = await showRetryFailedDialog({ mode, workspaceId });
            if (!ids || ids.length === 0) {
                btn.disabled = false;
                btn.textContent = 'Export Conversations';
                return;
            }

            const zip = new JSZip();
            const failures = [];
            const succeeded = [];

            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                btn.textContent = `🔁 补抓失败项 (${i + 1}/${ids.length})`;
                try {
                    const convData = await getConversation(id, workspaceId);
                    zip.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
                    zip.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData));
                    succeeded.push({
                        id,
                        title: convData.title || 'Untitled Conversation',
                        url: buildConversationUrl(id),
                        exported_at: new Date().toISOString()
                    });
                } catch (e) {
                    console.error(`❌ 补抓失败: ${id}`, e);
                    failures.push({
                        id,
                        title: 'Unknown title',
                        label: `补抓 ${i + 1}/${ids.length}`,
                        source: '手动补抓',
                        url: buildConversationUrl(id),
                        error: e?.message || String(e),
                        failed_at: new Date().toISOString()
                    });
                }

                await sleep(detailJitter());
            }

            zip.file('_retry_failed_manifest.json', JSON.stringify({
                exported_at: new Date().toISOString(),
                mode,
                workspaceId,
                requested_count: ids.length,
                success_count: succeeded.length,
                failure_count: failures.length,
                succeeded
            }, null, 2));

            if (failures.length > 0) {
                zip.file('_export_failures.json', JSON.stringify(failures, null, 2));
                zip.file('_export_failures.md', renderFailuresMarkdown(failures));
            }

            btn.textContent = '📦 生成补抓 ZIP…';
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const filename = mode === 'team'
                ? `chatgpt_retry_failed_team_${workspaceId}_${date}.zip`
                : `chatgpt_retry_failed_personal_${date}.zip`;
            downloadFile(blob, filename);

            alert(failures.length > 0
                ? `⚠️ 补抓完成：成功 ${succeeded.length} 条，失败 ${failures.length} 条。失败项已写入 _export_failures.md。`
                : `✅ 补抓完成：成功 ${succeeded.length} 条。`
            );
            btn.textContent = failures.length > 0 ? `⚠️ 补抓完成，失败 ${failures.length}` : '✅ 补抓完成';

        } catch (e) {
            console.error("补抓过程中发生严重错误:", e);
            alert(`补抓失败: ${e.message}。详情请查看控制台（F12 -> Console）。`);
            btn.textContent = '⚠️ Error';
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Export Conversations';
            }, 3000);
        }
    }


    function getConvTitle(item) {
        return item?.title || item?.conversation_template_id || item?.id || 'Untitled Conversation';
    }

    function getConvUpdatedTime(item) {
        return item?.update_time || item?.updated_at || item?.create_time || item?.created_at || null;
    }

    async function collectConversationItems(btn, workspaceId, includeArchived = true) {
        const itemsById = new Map();
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        const archiveStates = includeArchived ? [false, true] : [false];

        for (const is_archived of archiveStates) {
            let offset = 0, has_more = true, page = 0;
            do {
                btn.textContent = `📋 加载对话列表 (${is_archived ? 'Archived' : 'Active'} p${++page})`;
                const j = await fetchJsonWithRetry(
                    `/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`,
                    { headers },
                    '加载选择用对话列表'
                );

                if (j.items && j.items.length > 0) {
                    j.items.forEach(it => {
                        if (!it?.id) return;
                        rememberConversationMeta(it, { source: is_archived ? '普通历史/Archived' : '普通历史/Active', is_archived });
                        itemsById.set(it.id, {
                            id: it.id,
                            title: getConvTitle(it),
                            update_time: getConvUpdatedTime(it),
                            is_archived
                        });
                    });
                    has_more = j.items.length === PAGE_LIMIT;
                    offset += j.items.length;
                } else {
                    has_more = false;
                }

                await sleep(listJitter());
            } while (has_more);
        }

        return Array.from(itemsById.values()).sort((a, b) => {
            const ta = a.update_time ? new Date(a.update_time).getTime() : 0;
            const tb = b.update_time ? new Date(b.update_time).getTime() : 0;
            return tb - ta;
        });
    }

    function showConversationSelectDialog(items, options = {}) {
        const { mode = 'personal', workspaceId = null } = options;
        return new Promise(resolve => {
            const old = document.getElementById('select-export-dialog-overlay');
            if (old) old.remove();

            const overlay = document.createElement('div');
            overlay.id = 'select-export-dialog-overlay';
            Object.assign(overlay.style, {
                position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                backgroundColor: 'rgba(0,0,0,.5)', zIndex: '100000',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
            });

            const dialog = document.createElement('div');
            Object.assign(dialog.style, {
                background: '#fff', color: '#111', width: '760px', maxWidth: '92vw',
                height: '760px', maxHeight: '88vh', borderRadius: '12px',
                boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: '18px',
                boxSizing: 'border-box', fontFamily: 'Arial, sans-serif',
                display: 'flex', flexDirection: 'column', gap: '12px'
            });

            const header = document.createElement('div');
            header.innerHTML = `
                <div style="font-size:18px;font-weight:700;margin-bottom:6px;">选择要导出的对话</div>
                <div style="font-size:13px;color:#555;">共加载 ${items.length} 条历史记录。这里只加载标题列表，勾选后才会逐条下载完整详情。</div>
            `;

            const controls = document.createElement('div');
            controls.style.display = 'flex';
            controls.style.gap = '8px';
            controls.style.flexWrap = 'wrap';
            controls.innerHTML = `
                <input id="select-export-search" placeholder="搜索标题或 ID..." style="flex:1;min-width:220px;padding:8px;border:1px solid #ccc;border-radius:8px;">
                <button id="select-visible-btn" style="padding:8px 10px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">勾选当前筛选</button>
                <button id="unselect-visible-btn" style="padding:8px 10px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">取消当前筛选</button>
                <button id="select-recent-30-btn" style="padding:8px 10px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">最近30条</button>
                <button id="select-recent-100-btn" style="padding:8px 10px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">最近100条</button>
            `;

            const status = document.createElement('div');
            status.style.cssText = 'font-size:13px;color:#444;';

            const list = document.createElement('div');
            list.style.cssText = 'flex:1;overflow:auto;border:1px solid #ddd;border-radius:8px;background:#fafafa;padding:6px;';

            const footer = document.createElement('div');
            footer.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;';
            footer.innerHTML = `
                <div style="font-size:12px;color:#666;">建议先导最近30/100条，确认没问题再扩大范围。</div>
                <div style="display:flex;gap:8px;">
                    <button id="cancel-select-export-btn" style="padding:10px 14px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">取消</button>
                    <button id="start-select-export-btn" style="padding:10px 14px;border:none;border-radius:8px;background:#10a37f;color:#fff;font-weight:700;cursor:pointer;">导出已勾选</button>
                </div>
            `;

            dialog.appendChild(header);
            dialog.appendChild(controls);
            dialog.appendChild(status);
            dialog.appendChild(list);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const checked = new Set();
            let visibleItems = items.slice();

            function escapeHtml(s) {
                return String(s ?? '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            function fmtTime(t) {
                if (!t) return '';
                try { return new Date(t).toLocaleString(); } catch (_) { return String(t); }
            }

            function updateStatus() {
                status.textContent = `当前显示 ${visibleItems.length} 条；已勾选 ${checked.size} 条。`;
            }

            function render() {
                const q = document.getElementById('select-export-search').value.trim().toLowerCase();
                visibleItems = q
                    ? items.filter(it => (it.title || '').toLowerCase().includes(q) || it.id.toLowerCase().includes(q))
                    : items.slice();

                const html = visibleItems.map(it => {
                    const safeTitle = escapeHtml(it.title || 'Untitled Conversation');
                    const safeId = escapeHtml(it.id);
                    const time = escapeHtml(fmtTime(it.update_time));
                    return `
                        <label style="display:flex;gap:10px;align-items:flex-start;padding:8px;border-bottom:1px solid #eee;cursor:pointer;background:#fff;">
                            <input type="checkbox" class="select-export-checkbox" data-id="${safeId}" ${checked.has(it.id) ? 'checked' : ''} style="margin-top:4px;">
                            <div style="min-width:0;">
                                <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeTitle}</div>
                                <div style="font-size:12px;color:#777;">${time} ${it.is_archived ? ' · Archived' : ''}</div>
                                <div style="font-size:11px;color:#999;font-family:monospace;">${safeId}</div>
                            </div>
                        </label>
                    `;
                }).join('');

                list.innerHTML = html || '<div style="padding:18px;color:#777;">没有匹配结果</div>';

                list.querySelectorAll('.select-export-checkbox').forEach(cb => {
                    cb.onchange = () => {
                        if (cb.checked) checked.add(cb.dataset.id);
                        else checked.delete(cb.dataset.id);
                        updateStatus();
                    };
                });

                updateStatus();
            }

            document.getElementById('select-export-search').oninput = render;

            document.getElementById('select-visible-btn').onclick = () => {
                visibleItems.forEach(it => checked.add(it.id));
                render();
            };
            document.getElementById('unselect-visible-btn').onclick = () => {
                visibleItems.forEach(it => checked.delete(it.id));
                render();
            };
            document.getElementById('select-recent-30-btn').onclick = () => {
                checked.clear();
                items.slice(0, 30).forEach(it => checked.add(it.id));
                render();
            };
            document.getElementById('select-recent-100-btn').onclick = () => {
                checked.clear();
                items.slice(0, 100).forEach(it => checked.add(it.id));
                render();
            };
            document.getElementById('cancel-select-export-btn').onclick = () => {
                overlay.remove();
                resolve(null);
            };
            document.getElementById('start-select-export-btn').onclick = () => {
                const selected = items.filter(it => checked.has(it.id));
                if (selected.length === 0) {
                    alert('还没有勾选任何对话。');
                    return;
                }
                overlay.remove();
                resolve(selected);
            };

            overlay.onclick = e => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve(null);
                }
            };

            render();
        });
    }

    async function startSelectiveExportProcess(mode, workspaceId) {
        const btn = getExportButton();
        btn.disabled = true;

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
            return;
        }

        try {
            btn.textContent = '📋 加载可选对话列表…';
            const items = await collectConversationItems(btn, workspaceId, true);
            const selected = await showConversationSelectDialog(items, { mode, workspaceId });

            if (!selected || selected.length === 0) {
                btn.disabled = false;
                btn.textContent = 'Export Conversations';
                return;
            }

            const zip = new JSZip();
            const failures = [];
            const succeeded = [];

            for (let i = 0; i < selected.length; i++) {
                const item = selected[i];
                btn.textContent = `📥 选择导出 (${i + 1}/${selected.length})`;

                try {
                    const convData = await getConversation(item.id, workspaceId);
                    zip.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
                    zip.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData));
                    succeeded.push({
                        id: item.id,
                        title: convData.title || item.title || 'Untitled Conversation',
                        url: buildConversationUrl(item.id),
                        exported_at: new Date().toISOString()
                    });
                } catch (e) {
                    console.error(`❌ 选择导出失败: ${item.id}`, e);
                    const meta = getConversationMeta(item.id);
                    failures.push({
                        id: item.id,
                        title: item.title || meta.title || 'Unknown title',
                        label: `选择导出 ${i + 1}/${selected.length}`,
                        source: meta.source || '选择导出',
                        project_title: meta.project_title,
                        update_time: item.update_time || meta.update_time,
                        url: buildConversationUrl(item.id),
                        error: e?.message || String(e),
                        failed_at: new Date().toISOString()
                    });
                }

                await sleep(detailJitter());
            }

            zip.file('_selected_export_manifest.json', JSON.stringify({
                exported_at: new Date().toISOString(),
                mode,
                workspaceId,
                selected_count: selected.length,
                success_count: succeeded.length,
                failure_count: failures.length,
                selected,
                succeeded
            }, null, 2));

            if (failures.length > 0) {
                zip.file('_export_failures.json', JSON.stringify(failures, null, 2));
                zip.file('_export_failures.md', renderFailuresMarkdown(failures));
            }

            btn.textContent = '📦 生成选择导出 ZIP…';
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const filename = mode === 'team'
                ? `chatgpt_selected_team_backup_${workspaceId}_${date}.zip`
                : `chatgpt_selected_personal_backup_${date}.zip`;
            downloadFile(blob, filename);

            alert(failures.length > 0
                ? `⚠️ 选择导出完成：成功 ${succeeded.length} 条，失败 ${failures.length} 条。失败项已写入 _export_failures.md。`
                : `✅ 选择导出完成：成功 ${succeeded.length} 条。`
            );
            btn.textContent = failures.length > 0 ? `⚠️ 完成，失败 ${failures.length}` : '✅ 完成';

        } catch (e) {
            console.error("选择导出过程中发生严重错误:", e);
            alert(`选择导出失败: ${e.message}。详情请查看控制台（F12 -> Console）。`);
            btn.textContent = '⚠️ Error';
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Export Conversations';
            }, 3000);
        }
    }

    function showExportDialog() {
        if (document.getElementById('export-dialog-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '450px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);

        const renderStep = (step) => {
            let html = '';
            switch (step) {
                case 'team-selective':
                case 'team-retry':
                case 'team':
                    const isRetryTeam = step === 'team-retry';
                    const isSelectiveTeam = step === 'team-selective';
                    const detectedIds = detectAllWorkspaceIds();
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">${isRetryTeam ? '团队空间补抓失败项' : '导出团队空间'}</h2>`;

                    if (detectedIds.length > 1) {
                        html += `<div style="background: #eef2ff; border: 1px solid #818cf8; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 12px 0; font-weight: bold; color: #4338ca;">🔎 检测到多个 Workspace，请选择一个:</p>
                                     <div id="workspace-id-list">`;
                        detectedIds.forEach((id, index) => {
                            html += `<label style="display: block; margin-bottom: 8px; padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid #ddd; background: #fff;">
                                         <input type="radio" name="workspace_id" value="${id}" ${index === 0 ? 'checked' : ''}>
                                         <code style="margin-left: 8px; font-family: monospace; color: #555;">${id}</code>
                                      </label>`;
                        });
                        html += `</div></div>`;
                    } else if (detectedIds.length === 1) {
                        html += `<div style="background: #f0fdf4; border: 1px solid #4ade80; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 8px 0; font-weight: bold; color: #166534;">✅ 已自动检测到 Workspace ID:</p>
                                     <code id="workspace-id-code" style="background: #e0e7ff; padding: 4px 8px; border-radius: 4px; font-family: monospace; color: #4338ca; word-break: break-all;">${detectedIds[0]}</code>
                                   </div>`;
                    } else {
                        html += `<div style="background: #fffbeb; border: 1px solid #facc15; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0; color: #92400e;">⚠️ 未能自动检测到 Workspace ID。</p>
                                     <p style="margin: 8px 0 0 0; font-size: 12px; color: #92400e;">请尝试刷新页面或打开一个团队对话，或在下方手动输入。</p>
                                   </div>
                                   <label for="team-id-input" style="display: block; margin-bottom: 8px; font-weight: bold;">手动输入 Team Workspace ID:</label>
                                   <input type="text" id="team-id-input" placeholder="粘贴您的 Workspace ID (ws-...)" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">`;
                    }

                    html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 24px;">
                                 <button id="back-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">返回</button>
                                 <button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">开始导出 (ZIP)</button>
                               </div>`;
                    break;

                case 'initial':
                default:
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">选择要导出的空间</h2>
                                <div style="display: flex; flex-direction: column; gap: 12px;">
                                    <button id="select-personal-selected-btn" style="padding: 14px; text-align: left; border: 1px solid #10a37f; border-radius: 8px; background: #ecfdf5; cursor: pointer; width: 100%;">
                                        <strong style="font-size: 16px;">个人空间：选择部分对话导出</strong>
                                        <p style="margin: 4px 0 0 0; color: #666;">先加载历史标题列表，勾选需要的对话，再导出完整详情。</p>
                                    </button>
                                    <button id="retry-personal-btn" style="padding: 14px; text-align: left; border: 1px solid #10a37f; border-radius: 8px; background: #ecfdf5; cursor: pointer; width: 100%;">
                                        <strong style="font-size: 16px;">个人空间：补抓指定对话 / 失败项</strong>
                                        <p style="margin: 4px 0 0 0; color: #666;">粘贴失败链接/ID，或选择 _export_failures.json，只导出这些对话。</p>
                                    </button>
                                    <button id="select-personal-btn" style="padding: 14px; text-align: left; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb; cursor: pointer; width: 100%;">
                                        <strong style="font-size: 16px;">个人空间：全量导出</strong>
                                        <p style="margin: 4px 0 0 0; color: #666;">导出您个人账户下的所有对话。</p>
                                    </button>
                                    <button id="select-team-selected-btn" style="padding: 14px; text-align: left; border: 1px solid #10a37f; border-radius: 8px; background: #ecfdf5; cursor: pointer; width: 100%;">
                                        <strong style="font-size: 16px;">团队空间：选择部分对话导出</strong>
                                        <p style="margin: 4px 0 0 0; color: #666;">先选择 Workspace，再加载历史标题列表并勾选。</p>
                                    </button>
                                    <button id="retry-team-btn" style="padding: 14px; text-align: left; border: 1px solid #10a37f; border-radius: 8px; background: #ecfdf5; cursor: pointer; width: 100%;">
                                        <strong style="font-size: 16px;">团队空间：补抓指定对话 / 失败项</strong>
                                        <p style="margin: 4px 0 0 0; color: #666;">先选择 Workspace，再补抓指定失败项。</p>
                                    </button>
                                    <button id="select-team-btn" style="padding: 14px; text-align: left; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb; cursor: pointer; width: 100%;">
                                        <strong style="font-size: 16px;">团队空间：全量导出</strong>
                                        <p style="margin: 4px 0 0 0; color: #666;">导出团队空间下的对话，将自动检测ID。</p>
                                    </button>
                                </div>
                                <div style="display: flex; justify-content: flex-end; margin-top: 20px;">
                                    <button id="cancel-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">取消</button>
                                </div>`;
                    break;
            }
            dialog.innerHTML = html;
            attachListeners(step);
        };

        const attachListeners = (step) => {
            if (step === 'initial') {
                document.getElementById('select-personal-selected-btn').onclick = () => {
                    closeDialog();
                    startSelectiveExportProcess('personal', null);
                };
                document.getElementById('retry-personal-btn').onclick = () => {
                    closeDialog();
                    startRetryFailedExportProcess('personal', null);
                };
                document.getElementById('select-personal-btn').onclick = () => {
                    closeDialog();
                    startExportProcess('personal', null);
                };
                document.getElementById('select-team-selected-btn').onclick = () => renderStep('team-selective');
                document.getElementById('retry-team-btn').onclick = () => renderStep('team-retry');
                document.getElementById('select-team-btn').onclick = () => renderStep('team');
                document.getElementById('cancel-btn').onclick = closeDialog;
            } else if (step === 'team' || step === 'team-retry' || step === 'team-selective') {
                document.getElementById('back-btn').onclick = () => renderStep('initial');
                document.getElementById('start-team-export-btn').onclick = () => {
                    let workspaceId = '';
                    const radioChecked = document.querySelector('input[name="workspace_id"]:checked');
                    const codeEl = document.getElementById('workspace-id-code');
                    const inputEl = document.getElementById('team-id-input');

                    if (radioChecked) {
                        workspaceId = radioChecked.value;
                    } else if (codeEl) {
                        workspaceId = codeEl.textContent;
                    } else if (inputEl) {
                        workspaceId = inputEl.value.trim();
                    }

                    if (!workspaceId) {
                        alert('请选择或输入一个有效的 Team Workspace ID！');
                        return;
                    }
                    closeDialog();
                    if (step === 'team-retry') {
                        startRetryFailedExportProcess('team', workspaceId);
                    } else if (step === 'team-selective') {
                        startSelectiveExportProcess('team', workspaceId);
                    } else {
                        startExportProcess('team', workspaceId);
                    }
                };
            }
        };

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };
        renderStep('initial');
    }

    function addBtn() {
        if (document.getElementById('gpt-rescue-btn')) return;
        const b = document.createElement('button');
        b.id = 'gpt-rescue-btn';
        b.textContent = 'Export Conversations';
        Object.assign(b.style, {
            position: 'fixed', bottom: '24px', right: '24px', zIndex: '99997',
            padding: '10px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer',
            fontWeight: 'bold', background: '#10a37f', color: '#fff', fontSize: '14px',
            boxShadow: '0 3px 12px rgba(0,0,0,.15)', userSelect: 'none'
        });
        b.onclick = showExportDialog;
        document.body.appendChild(b);
    }

    // --- 脚本启动 ---
    setTimeout(addBtn, 2000);

    window.ChatGPTExporter = window.ChatGPTExporter || {};
    Object.assign(window.ChatGPTExporter, {
        showDialog: showExportDialog,
        startManualExport: (mode = 'personal', workspaceId = null) => startExportProcess(mode, workspaceId),
        startRetryFailedExport: (mode = 'personal', workspaceId = null) => startRetryFailedExportProcess(mode, workspaceId),
        startSelectiveExport: (mode = 'personal', workspaceId = null) => startSelectiveExportProcess(mode, workspaceId),
        startScheduledExport
    });

    document.documentElement.setAttribute('data-chatgpt-exporter-ready', '1');
    window.dispatchEvent(new CustomEvent('CHATGPT_EXPORTER_READY'));

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data?.type !== 'CHATGPT_EXPORTER_COMMAND') return;
        const api = window.ChatGPTExporter;
        if (!api) return;
        try {
            switch (data.action) {
                case 'START_SCHEDULED_EXPORT':
                    api.startScheduledExport(data.payload || {});
                    break;
                case 'OPEN_DIALOG':
                    api.showDialog();
                    break;
                case 'START_MANUAL_EXPORT':
                    api.startManualExport(data.payload?.mode, data.payload?.workspaceId);
                    break;
                default:
                    console.warn('[ChatGPT Exporter] 未知命令:', data.action);
            }
        } catch (err) {
            console.error('[ChatGPT Exporter] 处理命令失败:', err);
        }
    });

})();