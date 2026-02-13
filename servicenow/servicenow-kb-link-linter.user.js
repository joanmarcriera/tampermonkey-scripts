// ==UserScript==
// @name         ServiceNow KB Link Linter
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.1
// @description  Lint KB article links: malformed KB URLs, duplicates, and dead KB targets. Supports ESC Portal.
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @match        *://*/esc?id=kb_article*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const BUTTON_ID = 'kb-link-linter-btn';
    const OVERLAY_ID = 'kb-link-linter-overlay';
    const PANEL_ID = 'kb-link-linter-panel';
    const CHUNK_SIZE = 40;

    const COLORS = {
        accent: '#f97316',
        accentHover: '#ea580c',
        bgPrimary: '#0f172a',
        bgSecondary: '#020617',
        border: '#334155',
        textPrimary: '#e2e8f0',
        textSecondary: '#94a3b8',
        good: '#22c55e',
        warn: '#f59e0b',
        bad: '#ef4444',
        info: '#38bdf8',
    };

    const state = {
        running: false,
        panel: null,
        content: null,
        loading: null,
        status: null,
    };

    function normalizeText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function truncate(text, maxLen) {
        if (!text) return '';
        return text.length > maxLen ? text.slice(0, maxLen - 3) + '...' : text;
    }

    function getAuthToken() {
        return window.g_ck || '';
    }

    function buildKbUrl(kbNumber) {
        return window.location.origin + '/kb_view.do?sysparm_article=' + encodeURIComponent(kbNumber);
    }

    function getArticleHtml() {
        const original = document.getElementById('articleOriginal');
        if (original && original.value) return original.value;

        const article = document.getElementById('article');
        if (article && article.innerHTML) return article.innerHTML;

        const portalContent = document.querySelector('.kb-article-content') ||
                            document.querySelector('.kb-article-body') ||
                            document.querySelector('article .kb-content') ||
                            document.querySelector('.article-content');
        if (portalContent) return portalContent.innerHTML;

        return '';
    }

    function isKbArticleLink(urlObj) {
        const path = urlObj.pathname.toLowerCase();
        if (path.endsWith('/kb_view.do') || path.endsWith('/kb_article.do')) return true;
        if (urlObj.searchParams.get('id') === 'kb_article') return true;

        const href = urlObj.href.toLowerCase();
        return href.includes('kb_view.do') || href.includes('kb_article');
    }

    function normalizeUrl(urlObj) {
        const normalized = new URL(urlObj.href);
        normalized.hash = '';
        return normalized.href;
    }

    function extractKbTarget(urlObj, rawHref) {
        const direct = urlObj.searchParams.get('sysparm_article') || urlObj.searchParams.get('number');
        if (direct) {
            const kb = direct.trim().toUpperCase();
            if (/^KB\d+$/.test(kb)) return { kb: kb };
        }

        const sysId = urlObj.searchParams.get('sys_id') || urlObj.searchParams.get('sysparm_sys_id');
        if (sysId && /^[0-9a-f]{32}$/.test(sysId)) return { sysId: sysId };

        const text = String(rawHref || '').toUpperCase();
        const match = text.match(/\bKB\d+\b/);
        if (match) return { kb: match[0] };

        return { error: 'Missing KB identification parameter' };
    }

    function lintLinksFromHtml(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const anchors = Array.from(doc.querySelectorAll('a[href]'));

        const kbLinks = [];
        const malformedKbLinks = [];
        const allUrlCounts = new Map();
        let kbCandidateCount = 0;

        for (let i = 0; i < anchors.length; i += 1) {
            const a = anchors[i];
            const rawHref = normalizeText(a.getAttribute('href'));
            if (!rawHref || rawHref.startsWith('#')) continue;

            const lower = rawHref.toLowerCase();
            if (lower.startsWith('mailto:') || lower.startsWith('javascript:') || lower.startsWith('tel:')) continue;

            let urlObj;
            try {
                urlObj = new URL(rawHref, window.location.origin);
            } catch (e) {
                if (rawHref.toLowerCase().includes('kb')) {
                    malformedKbLinks.push({
                        text: normalizeText(a.textContent) || '(no label)',
                        href: rawHref,
                        reason: 'Invalid URL format',
                    });
                }
                continue;
            }

            const normalizedHref = normalizeUrl(urlObj);
            const existingCount = allUrlCounts.get(normalizedHref) || 0;
            allUrlCounts.set(normalizedHref, existingCount + 1);

            if (!isKbArticleLink(urlObj)) continue;
            kbCandidateCount += 1;

            const parsed = extractKbTarget(urlObj, rawHref);
            const label = normalizeText(a.textContent) || '(no label)';

            if (parsed.kb || parsed.sysId) {
                kbLinks.push({
                    kb: parsed.kb || parsed.sysId,
                    text: label,
                    href: normalizedHref,
                });
            } else {
                malformedKbLinks.push({
                    text: label,
                    href: normalizedHref,
                    reason: parsed.error || 'Invalid KB link',
                });
            }
        }

        return {
            totalAnchors: anchors.length,
            kbCandidateCount: kbCandidateCount,
            kbLinks: kbLinks,
            malformedKbLinks: malformedKbLinks,
            allUrlCounts: allUrlCounts,
        };
    }

    function collectDuplicateKbTargets(kbLinks) {
        const map = new Map();
        for (const link of kbLinks) {
            if (!map.has(link.kb)) map.set(link.kb, []);
            map.get(link.kb).push(link);
        }

        const duplicates = [];
        for (const entry of map.entries()) {
            const kb = entry[0];
            const links = entry[1];
            if (links.length < 2) continue;
            duplicates.push({
                kb: kb,
                count: links.length,
                sampleTexts: links.slice(0, 3).map(function (item) { return item.text; }),
            });
        }

        duplicates.sort(function (a, b) { return b.count - a.count; });
        return duplicates;
    }

    function collectDuplicateUrls(allUrlCounts) {
        const duplicates = [];
        for (const entry of allUrlCounts.entries()) {
            const url = entry[0];
            const count = entry[1];
            if (count < 2) continue;
            duplicates.push({ url: url, count: count });
        }
        duplicates.sort(function (a, b) { return b.count - a.count; });
        return duplicates;
    }

    async function fetchJson(url) {
        const resp = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'X-UserToken': getAuthToken(),
            },
        });

        if (!resp.ok) {
            const err = new Error('API error ' + resp.status);
            err.status = resp.status;
            throw err;
        }

        return resp.json();
    }

    function chunkArray(items, chunkSize) {
        const chunks = [];
        for (let i = 0; i < items.length; i += chunkSize) {
            chunks.push(items.slice(i, i + chunkSize));
        }
        return chunks;
    }

    async function resolveKbTargets(ids) {
        const result = new Map();
        if (ids.length === 0) return result;

        const chunks = chunkArray(ids, CHUNK_SIZE);
        for (const chunk of chunks) {
            const kbNums = chunk.filter(id => id.startsWith('KB'));
            const sysIds = chunk.filter(id => !id.startsWith('KB'));

            let queries = [];
            if (kbNums.length > 0) queries.push('numberIN' + kbNums.join(','));
            if (sysIds.length > 0) queries.push('sys_idIN' + sysIds.join(','));

            const query = queries.join('^OR');
            const url = window.location.origin +
                '/api/now/table/kb_knowledge?sysparm_query=' + encodeURIComponent(query) +
                '&sysparm_fields=number,sys_id,short_description,workflow_state&sysparm_limit=' + chunk.length;
            const data = await fetchJson(url);
            const records = data.result || [];
            for (const record of records) {
                const number = normalizeText(record.number).toUpperCase();
                const sys_id = record.sys_id;
                const entry = {
                    number: number,
                    title: normalizeText(record.short_description) || number,
                    workflowState: normalizeText(record.workflow_state || 'unknown').toLowerCase(),
                };
                if (number) result.set(number, entry);
                if (sys_id) result.set(sys_id, entry);
            }
        }

        return result;
    }

    async function runLint() {
        const html = getArticleHtml();
        if (!html) {
            throw new Error('Could not find article content.');
        }

        const linted = lintLinksFromHtml(html);
        const duplicateTargets = collectDuplicateKbTargets(linted.kbLinks);
        const duplicateUrls = collectDuplicateUrls(linted.allUrlCounts);

        const uniqueTargets = Array.from(new Set(linted.kbLinks.map(function (item) { return item.kb; }))).sort();
        let apiError = '';
        let deadTargets = [];
        let retiredTargets = [];

        try {
            const resolved = await resolveKbTargets(uniqueTargets);
            deadTargets = uniqueTargets.filter(function (id) { return !resolved.has(id); });

            retiredTargets = uniqueTargets
                .map(function (id) { return resolved.get(id); })
                .filter(function (item) {
                    return item && (item.workflowState === 'retired' || item.workflowState === 'pending_retirement');
                });

            // Deduplicate retired targets if both KB and sys_id were used
            const seen = new Set();
            retiredTargets = retiredTargets.filter(item => {
                if (seen.has(item.number)) return false;
                seen.add(item.number);
                return true;
            });
        } catch (e) {
            apiError = e.message || 'Could not validate KB targets';
        }

        return {
            linted: linted,
            duplicateTargets: duplicateTargets,
            duplicateUrls: duplicateUrls,
            uniqueTargetCount: uniqueTargets.length,
            deadTargets: deadTargets,
            retiredTargets: retiredTargets,
            apiError: apiError,
            ranAt: new Date(),
        };
    }

    function sectionTitle(text, color) {
        const h = document.createElement('h3');
        h.textContent = text;
        Object.assign(h.style, {
            margin: '0 0 6px',
            fontSize: '13px',
            color: color,
        });
        return h;
    }

    function sectionBox() {
        const box = document.createElement('div');
        Object.assign(box.style, {
            border: '1px solid ' + COLORS.border,
            borderRadius: '8px',
            padding: '10px',
            background: '#111827',
            marginBottom: '10px',
        });
        return box;
    }

    function metaLine(label, value) {
        const row = document.createElement('div');
        row.style.marginBottom = '2px';

        const k = document.createElement('span');
        k.textContent = label + ': ';
        k.style.color = COLORS.textSecondary;

        const v = document.createElement('span');
        v.textContent = value;
        v.style.color = COLORS.textPrimary;

        row.appendChild(k);
        row.appendChild(v);
        return row;
    }

    function addEmpty(parent, message) {
        const empty = document.createElement('div');
        empty.textContent = message;
        empty.style.color = COLORS.textSecondary;
        empty.style.fontSize = '12px';
        parent.appendChild(empty);
    }

    function addActionLink(parent, label, href) {
        let safeHref = '';
        try {
            const parsed = new URL(href, window.location.origin);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                safeHref = parsed.href;
            }
        } catch (e) {
            safeHref = '';
        }
        if (!safeHref) return;

        const a = document.createElement('a');
        a.href = safeHref;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = label;
        Object.assign(a.style, {
            color: COLORS.info,
            textDecoration: 'none',
            fontSize: '12px',
            marginLeft: '8px',
        });
        a.onmouseover = function () { a.style.textDecoration = 'underline'; };
        a.onmouseout = function () { a.style.textDecoration = 'none'; };
        parent.appendChild(a);
    }

    function addSimpleList(parent, items) {
        for (const item of items) {
            const row = document.createElement('div');
            Object.assign(row.style, {
                borderTop: '1px solid #1f2937',
                paddingTop: '6px',
                marginTop: '6px',
            });
            row.textContent = item;
            parent.appendChild(row);
        }
    }

    function renderReport(report) {
        state.content.innerHTML = '';

        const issueCount = report.malformedKbLinksCount + report.deadTargets.length;
        const warnCount = report.duplicateTargets.length + report.duplicateUrls.length + report.retiredTargets.length;
        let statusLabel = 'Looks Good';
        let statusColor = COLORS.good;
        if (issueCount > 0) {
            statusLabel = 'Issues Found';
            statusColor = COLORS.bad;
        } else if (warnCount > 0) {
            statusLabel = 'Needs Cleanup';
            statusColor = COLORS.warn;
        }

        const summary = sectionBox();
        summary.appendChild(sectionTitle('Summary', statusColor));
        summary.appendChild(metaLine('Status', statusLabel));
        summary.appendChild(metaLine('Anchors scanned', String(report.linted.totalAnchors)));
        summary.appendChild(metaLine('KB links checked', String(report.linted.kbCandidateCount)));
        summary.appendChild(metaLine('Unique KB targets', String(report.uniqueTargetCount)));
        summary.appendChild(metaLine('Lint run', report.ranAt.toLocaleString()));
        state.content.appendChild(summary);

        const malformedBox = sectionBox();
        malformedBox.appendChild(sectionTitle('Malformed KB Links (' + report.linted.malformedKbLinks.length + ')', COLORS.bad));
        if (report.linted.malformedKbLinks.length === 0) {
            addEmpty(malformedBox, 'No malformed KB links found.');
        } else {
            for (const item of report.linted.malformedKbLinks) {
                const row = document.createElement('div');
                Object.assign(row.style, {
                    borderTop: '1px solid #1f2937',
                    paddingTop: '6px',
                    marginTop: '6px',
                    fontSize: '12px',
                });
                row.innerHTML =
                    '<strong>' + escapeHtml(truncate(item.text, 80)) + '</strong><br>' +
                    '<span style="color:' + COLORS.textSecondary + '">' + escapeHtml(item.reason) + '</span><br>' +
                    '<span style="color:' + COLORS.textSecondary + '">' + escapeHtml(truncate(item.href, 120)) + '</span>';
                addActionLink(row, 'Open', item.href);
                malformedBox.appendChild(row);
            }
        }
        state.content.appendChild(malformedBox);

        const duplicateKbBox = sectionBox();
        duplicateKbBox.appendChild(sectionTitle('Duplicate KB Targets (' + report.duplicateTargets.length + ')', COLORS.warn));
        if (report.duplicateTargets.length === 0) {
            addEmpty(duplicateKbBox, 'No duplicate KB targets.');
        } else {
            const lines = report.duplicateTargets.map(function (item) {
                const labels = item.sampleTexts.join(', ');
                return item.kb + ' appears ' + item.count + ' times (' + labels + ')';
            });
            addSimpleList(duplicateKbBox, lines);
        }
        state.content.appendChild(duplicateKbBox);

        const duplicateUrlBox = sectionBox();
        duplicateUrlBox.appendChild(sectionTitle('Duplicate URLs (' + report.duplicateUrls.length + ')', COLORS.warn));
        if (report.duplicateUrls.length === 0) {
            addEmpty(duplicateUrlBox, 'No duplicate URLs.');
        } else {
            for (const item of report.duplicateUrls.slice(0, 40)) {
                const row = document.createElement('div');
                Object.assign(row.style, {
                    borderTop: '1px solid #1f2937',
                    paddingTop: '6px',
                    marginTop: '6px',
                    fontSize: '12px',
                });
                row.textContent = item.count + 'x - ' + truncate(item.url, 120);
                duplicateUrlBox.appendChild(row);
            }
            if (report.duplicateUrls.length > 40) {
                addEmpty(duplicateUrlBox, 'Showing first 40 duplicate URLs.');
            }
        }
        state.content.appendChild(duplicateUrlBox);

        const deadBox = sectionBox();
        deadBox.appendChild(sectionTitle('Dead KB Targets (' + report.deadTargets.length + ')', COLORS.bad));
        if (report.apiError) {
            addEmpty(deadBox, 'Could not validate targets: ' + report.apiError);
        } else if (report.deadTargets.length === 0) {
            addEmpty(deadBox, 'No dead KB targets found.');
        } else {
            for (const id of report.deadTargets) {
                const row = document.createElement('div');
                Object.assign(row.style, {
                    borderTop: '1px solid #1f2937',
                    paddingTop: '6px',
                    marginTop: '6px',
                    fontSize: '12px',
                });
                row.textContent = id + ' (not found in kb_knowledge)';
                if (id.startsWith('KB')) addActionLink(row, 'Open', buildKbUrl(id));
                deadBox.appendChild(row);
            }
        }
        state.content.appendChild(deadBox);

        const retiredBox = sectionBox();
        retiredBox.appendChild(sectionTitle('Retired Targets (' + report.retiredTargets.length + ')', COLORS.warn));
        if (report.apiError) {
            addEmpty(retiredBox, 'Skipped because target validation failed.');
        } else if (report.retiredTargets.length === 0) {
            addEmpty(retiredBox, 'No retired or pending-retirement targets.');
        } else {
            for (const item of report.retiredTargets) {
                const row = document.createElement('div');
                Object.assign(row.style, {
                    borderTop: '1px solid #1f2937',
                    paddingTop: '6px',
                    marginTop: '6px',
                    fontSize: '12px',
                });
                row.textContent = item.number + ' - ' + truncate(item.title, 90) + ' [' + item.workflowState + ']';
                addActionLink(row, 'Open', buildKbUrl(item.number));
                retiredBox.appendChild(row);
            }
        }
        state.content.appendChild(retiredBox);
    }

    function setLoading(visible) {
        state.running = visible;
        state.loading.style.display = visible ? 'block' : 'none';
        state.content.style.display = visible ? 'none' : 'block';
    }

    function setStatusText(text) {
        state.status.textContent = text;
    }

    async function runLintAndRender() {
        if (state.running) return;
        setLoading(true);
        setStatusText('Linting links...');
        try {
            const report = await runLint();
            report.malformedKbLinksCount = report.linted.malformedKbLinks.length;
            renderReport(report);
            setStatusText('Done.');
        } catch (e) {
            state.content.innerHTML = '';
            const box = sectionBox();
            box.appendChild(sectionTitle('Linter Error', COLORS.bad));
            addEmpty(box, e.message || 'Unknown error');
            state.content.appendChild(box);
            state.content.style.display = 'block';
            setStatusText('Failed.');
        } finally {
            setLoading(false);
        }
    }

    function hidePanel() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (overlay) overlay.style.display = 'none';
    }

    function showPanel() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;
        overlay.style.display = 'block';
        runLintAndRender();
    }

    function ensurePanel() {
        if (state.panel) return;

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        Object.assign(overlay.style, {
            display: 'none',
            position: 'fixed',
            inset: '0',
            zIndex: '10008',
            background: 'rgba(0,0,0,0.35)',
        });
        overlay.onclick = function (e) {
            if (e.target === overlay) hidePanel();
        };

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        Object.assign(panel.style, {
            position: 'absolute',
            top: '6vh',
            right: '20px',
            width: '460px',
            maxWidth: 'calc(100vw - 40px)',
            height: '86vh',
            display: 'flex',
            flexDirection: 'column',
            background: COLORS.bgPrimary,
            color: COLORS.textPrimary,
            border: '1px solid ' + COLORS.border,
            borderRadius: '10px',
            boxShadow: '0 12px 28px rgba(0,0,0,0.5)',
            overflow: 'hidden',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            background: COLORS.bgSecondary,
            borderBottom: '1px solid ' + COLORS.border,
            padding: '10px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: '0',
        });

        const title = document.createElement('div');
        title.textContent = 'KB Link Linter';
        Object.assign(title.style, {
            fontSize: '14px',
            fontWeight: '700',
        });

        const close = document.createElement('button');
        close.textContent = '×';
        Object.assign(close.style, {
            background: 'transparent',
            color: COLORS.textSecondary,
            border: 'none',
            fontSize: '24px',
            lineHeight: '1',
            cursor: 'pointer',
            padding: '0',
        });
        close.onclick = hidePanel;
        close.onmouseover = function () { close.style.color = COLORS.textPrimary; };
        close.onmouseout = function () { close.style.color = COLORS.textSecondary; };

        header.appendChild(title);
        header.appendChild(close);

        const loading = document.createElement('div');
        loading.textContent = 'Linting article links...';
        Object.assign(loading.style, {
            display: 'none',
            padding: '24px 12px',
            color: COLORS.textSecondary,
            fontSize: '13px',
        });

        const content = document.createElement('div');
        Object.assign(content.style, {
            flex: '1',
            overflow: 'auto',
            padding: '12px',
        });

        const footer = document.createElement('div');
        Object.assign(footer.style, {
            borderTop: '1px solid ' + COLORS.border,
            background: COLORS.bgSecondary,
            padding: '8px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            flexShrink: '0',
        });

        const refresh = document.createElement('button');
        refresh.textContent = 'Refresh';
        Object.assign(refresh.style, {
            border: '1px solid ' + COLORS.border,
            background: COLORS.accent,
            color: '#fff',
            borderRadius: '6px',
            fontSize: '12px',
            padding: '6px 10px',
            cursor: 'pointer',
        });
        refresh.onmouseover = function () { refresh.style.background = COLORS.accentHover; };
        refresh.onmouseout = function () { refresh.style.background = COLORS.accent; };
        refresh.onclick = runLintAndRender;

        const status = document.createElement('span');
        status.textContent = 'Ready';
        Object.assign(status.style, {
            color: COLORS.textSecondary,
            fontSize: '12px',
        });

        footer.appendChild(refresh);
        footer.appendChild(status);

        panel.appendChild(header);
        panel.appendChild(loading);
        panel.appendChild(content);
        panel.appendChild(footer);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        state.panel = panel;
        state.content = content;
        state.loading = loading;
        state.status = status;
    }

    function addButton() {
        if (document.getElementById(BUTTON_ID)) return;
        ensurePanel();

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.textContent = 'KB Link Linter';
        Object.assign(button.style, {
            position: 'fixed',
            right: '20px',
            bottom: '20px',
            zIndex: '10007',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid #9a3412',
            background: COLORS.accent,
            color: '#fff',
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: '0 6px 12px rgba(0,0,0,0.25)',
        });
        button.onmouseover = function () { button.style.background = COLORS.accentHover; };
        button.onmouseout = function () { button.style.background = COLORS.accent; };
        button.onclick = showPanel;

        document.body.appendChild(button);
    }

    setTimeout(addButton, 3000);
})();
