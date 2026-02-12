// ==UserScript==
// @name         ServiceNow KB Reverse Links
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.1
// @description  Show which KB articles and tasks reference the current KB article (incoming links)
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @match        *://*/esc?id=kb_article*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ─── Constants ───────────────────────────────────────────────

    const COLORS = {
        accent: '#0ea5e9',
        accentHover: '#38bdf8',
        bgPrimary: '#1e1e1e',
        bgSecondary: '#0f172a',
        border: '#334155',
        textPrimary: '#e2e8f0',
        textSecondary: '#94a3b8',
        kbDot: '#7c3aed',
        hyperlinkDot: '#3b82f6',
        taskDot: '#f59e0b',
        errorText: '#ef4444',
    };

    // ─── Helpers ─────────────────────────────────────────────────

    function getKbNumber() {
        const el = document.getElementById('articleNumberReadonly');
        if (el && el.textContent.trim()) {
            return el.textContent.trim().split(/\s+/)[0];
        }
        // Fallback for ESC portal
        const params = new URLSearchParams(window.location.search);
        const article = params.get('sysparm_article') || params.get('number');
        if (article && article.startsWith('KB')) return article;
        return null;
    }

    function getArticleTitle() {
        const el = document.getElementById('articleTitleReadonly');
        if (el && el.textContent.trim()) {
            return el.textContent.trim();
        }
        return document.title || 'KB Article';
    }

    function getAuthToken() {
        return window.g_ck || '';
    }

    function buildKbUrl(kbNumber) {
        return window.location.origin + '/kb_view.do?sysparm_article=' + encodeURIComponent(kbNumber);
    }

    function buildTaskUrl(taskNumber, sysClassName) {
        const table = sysClassName || 'task';
        return window.location.origin + '/nav_to.do?uri=' + encodeURIComponent(table) +
            '.do%3Fsysparm_query%3Dnumber%3D' + encodeURIComponent(taskNumber);
    }

    function truncate(text, maxLen) {
        if (!text) return '';
        return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
    }

    function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    function friendlyTaskType(sysClassName) {
        const map = {
            incident: 'Incident',
            sc_task: 'Catalog Task',
            sc_req_item: 'Request Item',
            change_request: 'Change',
            problem: 'Problem',
            hr_case: 'HR Case',
            sn_si_incident: 'Security Incident',
        };
        return map[sysClassName] || sysClassName || 'Task';
    }

    // ─── API Layer ──────────────────────────────────────────────

    async function fetchJson(url, maxRetries) {
        if (maxRetries === undefined) maxRetries = 2;
        let lastErr;
        for (var i = 0; i <= maxRetries; i++) {
            try {
                var resp = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'X-UserToken': getAuthToken(),
                    },
                });
                if (!resp.ok) {
                    var err = new Error('API error ' + resp.status);
                    err.status = resp.status;
                    err.totalCount = resp.headers.get('X-Total-Count');
                    throw err;
                }
                var data = await resp.json();
                data._totalCount = resp.headers.get('X-Total-Count');
                return data;
            } catch (e) {
                lastErr = e;
                if (e.status === 401 || e.status === 403 || e.status === 404) throw e;
                if (i < maxRetries) {
                    await new Promise(function (r) { setTimeout(r, 1000 * Math.pow(2, i)); });
                }
            }
        }
        throw lastErr;
    }

    async function resolveArticleSysId(kbNumber) {
        var base = window.location.origin;
        var url = base + '/api/now/table/kb_knowledge?sysparm_query=number=' +
            encodeURIComponent(kbNumber) +
            '&sysparm_fields=sys_id,number,short_description&sysparm_limit=1';

        var data = await fetchJson(url);
        if (!data.result || data.result.length === 0) {
            var err = new Error('Article ' + kbNumber + ' not found');
            err.status = 404;
            throw err;
        }

        var article = data.result[0];
        return {
            sysId: article.sys_id,
            number: article.number,
            title: article.short_description || kbNumber,
        };
    }

    // ─── Schema Discovery for kb_2_kb ───────────────────────────

    var cachedKb2KbFields = null;

    async function discoverKb2KbFields() {
        if (cachedKb2KbFields) return cachedKb2KbFields;

        var base = window.location.origin;

        // Strategy 1: fetch one record and inspect its structure
        try {
            var data = await fetchJson(base + '/api/now/table/kb_2_kb?sysparm_limit=1');
            if (data.result && data.result.length > 0) {
                var record = data.result[0];
                var refFields = [];

                for (var key in record) {
                    if (!record.hasOwnProperty(key)) continue;
                    var val = record[key];
                    // Reference fields in ServiceNow JSON are objects with { link, value }
                    if (val && typeof val === 'object' && val.link &&
                        typeof val.link === 'string' && val.link.includes('/kb_knowledge/')) {
                        refFields.push(key);
                    }
                }

                if (refFields.length >= 2) {
                    cachedKb2KbFields = { fieldA: refFields[0], fieldB: refFields[1] };
                    console.log('KB Reverse Links: discovered kb_2_kb fields:', cachedKb2KbFields);
                    return cachedKb2KbFields;
                }

                // If reference fields are stored as plain strings (sys_ids), try common names
                var candidates = ['kb_knowledge', 'kb_knowledge_related', 'u_kb_article',
                    'u_related_article', 'kb_article_one', 'kb_article_two',
                    'article', 'related_article'];
                var found = [];
                for (var c = 0; c < candidates.length; c++) {
                    if (record.hasOwnProperty(candidates[c])) {
                        found.push(candidates[c]);
                    }
                }
                if (found.length >= 2) {
                    cachedKb2KbFields = { fieldA: found[0], fieldB: found[1] };
                    console.log('KB Reverse Links: discovered kb_2_kb fields (string match):', cachedKb2KbFields);
                    return cachedKb2KbFields;
                }
            }
        } catch (e) {
            console.warn('KB Reverse Links: could not query kb_2_kb directly:', e.message);
            if (e.status === 403 || e.status === 404) {
                throw e; // no access to this table
            }
        }

        // Strategy 2: query sys_dictionary for reference columns on kb_2_kb
        try {
            var dictUrl = base + '/api/now/table/sys_dictionary' +
                '?sysparm_query=name=kb_2_kb^internal_type=reference^reference=kb_knowledge' +
                '&sysparm_fields=element,reference&sysparm_limit=10';
            var dictData = await fetchJson(dictUrl);
            if (dictData.result && dictData.result.length >= 2) {
                cachedKb2KbFields = {
                    fieldA: dictData.result[0].element,
                    fieldB: dictData.result[1].element,
                };
                console.log('KB Reverse Links: discovered kb_2_kb fields via sys_dictionary:', cachedKb2KbFields);
                return cachedKb2KbFields;
            }
        } catch (e) {
            console.warn('KB Reverse Links: could not query sys_dictionary:', e.message);
        }

        // Strategy 3: hardcoded fallback (most common ServiceNow field names)
        cachedKb2KbFields = { fieldA: 'kb_knowledge', fieldB: 'kb_knowledge_related' };
        console.log('KB Reverse Links: using fallback kb_2_kb field names:', cachedKb2KbFields);
        return cachedKb2KbFields;
    }

    // ─── Reverse Link Queries ───────────────────────────────────

    async function fetchReverseKbLinks(sysId, fieldA, fieldB) {
        var base = window.location.origin;
        var query = fieldA + '=' + sysId + '^OR' + fieldB + '=' + sysId;
        var fields = [
            fieldA, fieldA + '.number', fieldA + '.short_description',
            fieldB, fieldB + '.number', fieldB + '.short_description',
            'sys_id',
        ].join(',');

        var url = base + '/api/now/table/kb_2_kb' +
            '?sysparm_query=' + encodeURIComponent(query) +
            '&sysparm_fields=' + encodeURIComponent(fields) +
            '&sysparm_limit=100';

        var data = await fetchJson(url);
        var totalCount = parseInt(data._totalCount, 10) || 0;
        var results = data.result || [];
        var seen = new Set();
        var links = [];

        for (var i = 0; i < results.length; i++) {
            var record = results[i];

            // Find the "other" article — the one that is NOT sysId
            var otherNumber = null;
            var otherTitle = null;

            // Check fieldA side
            var aVal = record[fieldA];
            var aSysId = (aVal && typeof aVal === 'object') ? aVal.value : aVal;
            var aNumber = record[fieldA + '.number'] || '';
            var aTitle = record[fieldA + '.short_description'] || '';

            // Check fieldB side
            var bVal = record[fieldB];
            var bSysId = (bVal && typeof bVal === 'object') ? bVal.value : bVal;
            var bNumber = record[fieldB + '.number'] || '';
            var bTitle = record[fieldB + '.short_description'] || '';

            if (aSysId === sysId) {
                otherNumber = bNumber;
                otherTitle = bTitle;
            } else if (bSysId === sysId) {
                otherNumber = aNumber;
                otherTitle = aTitle;
            } else {
                // Shouldn't happen, but skip
                continue;
            }

            if (!otherNumber || seen.has(otherNumber)) continue;
            // Skip self-references
            if (otherNumber === state.kbNumber) continue;
            seen.add(otherNumber);

            links.push({
                number: otherNumber,
                title: otherTitle || otherNumber,
                url: buildKbUrl(otherNumber),
            });
        }

        return { links: links, totalCount: totalCount };
    }

    async function fetchReverseTaskLinks(sysId) {
        var base = window.location.origin;
        var url = base + '/api/now/table/m2m_kb_task' +
            '?sysparm_query=kb_knowledge=' + encodeURIComponent(sysId) +
            '&sysparm_fields=' + encodeURIComponent('task.number,task.short_description,task.sys_class_name,sys_id') +
            '&sysparm_limit=100';

        var data = await fetchJson(url);
        var totalCount = parseInt(data._totalCount, 10) || 0;
        var results = data.result || [];
        var seen = new Set();
        var links = [];

        for (var i = 0; i < results.length; i++) {
            var record = results[i];
            var taskNumber = record['task.number'] || '';
            var taskTitle = record['task.short_description'] || '';
            var taskClass = record['task.sys_class_name'] || 'task';

            if (!taskNumber || seen.has(taskNumber)) continue;
            seen.add(taskNumber);

            links.push({
                number: taskNumber,
                title: taskTitle || taskNumber,
                type: taskClass,
                url: buildTaskUrl(taskNumber, taskClass),
            });
        }

        return { links: links, totalCount: totalCount };
    }

    // ─── Hyperlink-based Reverse Search ────────────────────────

    /**
     * Search for KB articles whose body HTML contains a hyperlink to the target article.
     * This finds the same links the KB Graph View discovers by parsing article HTML.
     * Uses ServiceNow's CONTAINS query operator on the `text` field.
     */
    async function fetchReverseHyperlinkRefs(kbNumber) {
        var base = window.location.origin;
        // Search for articles whose HTML body contains a link to this KB number.
        // Articles link via sysparm_article=KBxxxxxx in kb_view.do or kb_article URLs.
        var searchTerm = 'sysparm_article=' + kbNumber;
        var url = base + '/api/now/table/kb_knowledge' +
            '?sysparm_query=textCONTAINS' + encodeURIComponent(searchTerm) +
            '^number!=' + encodeURIComponent(kbNumber) +
            '&sysparm_fields=number,short_description' +
            '&sysparm_limit=100';

        var data = await fetchJson(url);
        var totalCount = parseInt(data._totalCount, 10) || 0;
        var results = data.result || [];
        var seen = new Set();
        var links = [];

        for (var i = 0; i < results.length; i++) {
            var record = results[i];
            var num = record.number || '';
            if (!num || seen.has(num)) continue;
            seen.add(num);

            links.push({
                number: num,
                title: record.short_description || num,
                url: buildKbUrl(num),
            });
        }

        return { links: links, totalCount: totalCount };
    }

    // ─── State ──────────────────────────────────────────────────

    var state = {
        kbNumber: null,
        kbTitle: null,
        sysId: null,
        reverseKbLinks: [],
        reverseKbTotal: 0,
        hyperlinkRefs: [],
        hyperlinkRefsTotal: 0,
        reverseTaskLinks: [],
        reverseTaskTotal: 0,
        kbError: null,
        hyperlinkError: null,
        taskError: null,
        loading: false,
        initialized: false,
    };

    // ─── UI ─────────────────────────────────────────────────────

    var panelElements = null;

    function createPanel() {
        var overlay = document.createElement('div');
        overlay.id = 'kb-reverse-overlay';
        Object.assign(overlay.style, {
            display: 'none',
            position: 'fixed',
            top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0,0,0,0.3)',
            zIndex: '10001',
        });

        var panel = document.createElement('div');
        panel.id = 'kb-reverse-panel';
        Object.assign(panel.style, {
            position: 'absolute',
            top: '10vh',
            right: '20px',
            width: '380px',
            maxHeight: '80vh',
            background: COLORS.bgPrimary,
            border: '1px solid ' + COLORS.border,
            borderRadius: '8px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            overflow: 'hidden',
        });

        // Title bar
        var titleBar = document.createElement('div');
        Object.assign(titleBar.style, {
            background: COLORS.bgSecondary,
            color: COLORS.textPrimary,
            padding: '10px 16px',
            borderBottom: '1px solid ' + COLORS.border,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: '0',
        });

        var titleLeft = document.createElement('div');
        titleLeft.style.display = 'flex';
        titleLeft.style.alignItems = 'baseline';
        titleLeft.style.gap = '4px';

        var titleText = document.createElement('span');
        titleText.id = 'kb-reverse-title';
        titleText.textContent = 'Reverse Links';
        titleText.style.fontSize = '14px';
        titleText.style.fontWeight = '600';

        var authorLink = document.createElement('a');
        authorLink.href = 'https://www.linkedin.com/in/joanmarcriera/';
        authorLink.target = '_blank';
        authorLink.rel = 'noopener';
        authorLink.textContent = 'by Joan Marc Riera';
        Object.assign(authorLink.style, {
            color: COLORS.textSecondary,
            fontSize: '11px',
            textDecoration: 'none',
            marginLeft: '10px',
        });
        authorLink.onmouseover = function () { authorLink.style.color = COLORS.accentHover; };
        authorLink.onmouseout = function () { authorLink.style.color = COLORS.textSecondary; };

        titleLeft.appendChild(titleText);
        titleLeft.appendChild(authorLink);

        var closeBtn = document.createElement('button');
        closeBtn.textContent = '\u00d7';
        Object.assign(closeBtn.style, {
            background: 'transparent',
            border: 'none',
            color: COLORS.textSecondary,
            fontSize: '22px',
            cursor: 'pointer',
            padding: '0',
            lineHeight: '1',
        });
        closeBtn.onmouseover = function () { closeBtn.style.color = COLORS.textPrimary; };
        closeBtn.onmouseout = function () { closeBtn.style.color = COLORS.textSecondary; };
        closeBtn.onclick = function () { hidePanel(); };

        titleBar.appendChild(titleLeft);
        titleBar.appendChild(closeBtn);

        // Content area
        var contentArea = document.createElement('div');
        contentArea.id = 'kb-reverse-content';
        Object.assign(contentArea.style, {
            flex: '1',
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '12px 16px',
        });

        // Loading spinner
        var loading = document.createElement('div');
        loading.id = 'kb-reverse-loading';
        Object.assign(loading.style, {
            display: 'none',
            padding: '40px 0',
            textAlign: 'center',
        });
        var spinner = document.createElement('div');
        Object.assign(spinner.style, {
            width: '32px',
            height: '32px',
            border: '3px solid ' + COLORS.border,
            borderTop: '3px solid ' + COLORS.accent,
            borderRadius: '50%',
            animation: 'kb-reverse-spin 1s linear infinite',
            margin: '0 auto 12px',
        });
        var loadingText = document.createElement('div');
        loadingText.textContent = 'Loading reverse links...';
        loadingText.style.color = COLORS.textSecondary;
        loadingText.style.fontSize = '12px';
        loading.appendChild(spinner);
        loading.appendChild(loadingText);

        // Footer
        var footer = document.createElement('div');
        footer.id = 'kb-reverse-footer';
        Object.assign(footer.style, {
            background: COLORS.bgSecondary,
            borderTop: '1px solid ' + COLORS.border,
            padding: '8px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: '0',
            fontSize: '12px',
            color: COLORS.textSecondary,
        });

        var footerInfo = document.createElement('span');
        footerInfo.id = 'kb-reverse-footer-info';
        footerInfo.textContent = '';

        var refreshBtn = document.createElement('button');
        refreshBtn.textContent = '\u21bb Refresh';
        Object.assign(refreshBtn.style, {
            background: COLORS.bgPrimary,
            border: '1px solid ' + COLORS.border,
            color: COLORS.textPrimary,
            padding: '3px 10px',
            borderRadius: '4px',
            fontSize: '11px',
            cursor: 'pointer',
        });
        refreshBtn.onmouseover = function () { refreshBtn.style.background = COLORS.border; };
        refreshBtn.onmouseout = function () { refreshBtn.style.background = COLORS.bgPrimary; };
        refreshBtn.onclick = function () { handleRefresh(); };

        footer.appendChild(footerInfo);
        footer.appendChild(refreshBtn);

        panel.appendChild(titleBar);
        panel.appendChild(loading);
        panel.appendChild(contentArea);
        panel.appendChild(footer);

        overlay.appendChild(panel);

        // Keyframe animation
        var style = document.createElement('style');
        style.textContent = '@keyframes kb-reverse-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);

        // Close on overlay click
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) hidePanel();
        });

        document.body.appendChild(overlay);
        return {
            overlay: overlay,
            panel: panel,
            titleText: titleText,
            contentArea: contentArea,
            loading: loading,
            footerInfo: footerInfo,
            refreshBtn: refreshBtn,
        };
    }

    function showPanel() {
        if (!panelElements) panelElements = createPanel();
        panelElements.overlay.style.display = 'block';
    }

    function hidePanel() {
        if (panelElements) panelElements.overlay.style.display = 'none';
    }

    function setLoading(on) {
        if (!panelElements) return;
        panelElements.loading.style.display = on ? 'block' : 'none';
        panelElements.contentArea.style.display = on ? 'none' : 'block';
    }

    // ─── Rendering ──────────────────────────────────────────────

    function renderResults() {
        if (!panelElements) return;
        var area = panelElements.contentArea;
        clearChildren(area);

        // Determine which hyperlink refs are NOT already in the kb_2_kb results
        var kb2kbNumbers = new Set();
        for (var k = 0; k < state.reverseKbLinks.length; k++) {
            kb2kbNumbers.add(state.reverseKbLinks[k].number);
        }
        var hyperlinkOnly = state.hyperlinkRefs.filter(function (item) {
            return !kb2kbNumbers.has(item.number);
        });

        // KB Articles section (from kb_2_kb relationship table)
        renderSection(area, {
            title: 'Related articles (kb_2_kb) \u2014 ' + state.reverseKbLinks.length,
            subtitle: 'Explicit relationships defined in ServiceNow',
            totalNote: state.reverseKbTotal > state.reverseKbLinks.length
                ? '(showing ' + state.reverseKbLinks.length + ' of ' + state.reverseKbTotal + ')'
                : null,
            error: state.kbError,
            items: state.reverseKbLinks,
            dotColor: COLORS.kbDot,
            emptyMessage: 'No explicit KB relationships found for this article.',
            renderItem: function (item) {
                return renderLinkRow(item.number, item.title, item.url, COLORS.kbDot, null);
            },
        });

        // Spacer
        var spacer1 = document.createElement('div');
        spacer1.style.height = '16px';
        area.appendChild(spacer1);

        // Hyperlink references section (from text search)
        renderSection(area, {
            title: 'Linked from articles (hyperlinks) \u2014 ' + hyperlinkOnly.length,
            subtitle: 'Articles whose body text contains a hyperlink to this article',
            totalNote: null,
            error: state.hyperlinkError,
            items: hyperlinkOnly,
            dotColor: COLORS.hyperlinkDot,
            emptyMessage: 'No articles contain hyperlinks to this article.',
            renderItem: function (item) {
                return renderLinkRow(item.number, item.title, item.url, COLORS.hyperlinkDot, null);
            },
        });

        // Spacer
        var spacer2 = document.createElement('div');
        spacer2.style.height = '16px';
        area.appendChild(spacer2);

        // Tasks section
        renderSection(area, {
            title: 'Applied to tasks \u2014 ' + state.reverseTaskLinks.length,
            subtitle: 'Tasks where this article was applied (m2m_kb_task)',
            totalNote: state.reverseTaskTotal > state.reverseTaskLinks.length
                ? '(showing ' + state.reverseTaskLinks.length + ' of ' + state.reverseTaskTotal + ')'
                : null,
            error: state.taskError,
            items: state.reverseTaskLinks,
            dotColor: COLORS.taskDot,
            emptyMessage: 'No tasks reference this article.',
            renderItem: function (item) {
                return renderLinkRow(item.number, item.title, item.url, COLORS.taskDot, friendlyTaskType(item.type));
            },
        });

        // Update footer
        var total = state.reverseKbLinks.length + hyperlinkOnly.length + state.reverseTaskLinks.length;
        panelElements.footerInfo.textContent = total + ' reference' + (total !== 1 ? 's' : '') +
            ' \u2022 ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function renderSection(parent, opts) {
        // Section header
        var header = document.createElement('div');
        Object.assign(header.style, {
            fontSize: '12px',
            fontWeight: '600',
            color: COLORS.textSecondary,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            marginBottom: opts.subtitle ? '2px' : '8px',
        });
        header.textContent = opts.title;
        if (opts.totalNote) {
            var note = document.createElement('span');
            note.textContent = ' ' + opts.totalNote;
            note.style.fontWeight = '400';
            note.style.textTransform = 'none';
            note.style.letterSpacing = '0';
            header.appendChild(note);
        }
        parent.appendChild(header);

        // Subtitle / explanation
        if (opts.subtitle) {
            var sub = document.createElement('div');
            Object.assign(sub.style, {
                fontSize: '10px',
                color: COLORS.textSecondary,
                opacity: '0.7',
                marginBottom: '8px',
                textTransform: 'none',
                letterSpacing: '0',
                fontWeight: '400',
            });
            sub.textContent = opts.subtitle;
            parent.appendChild(sub);
        }

        // Divider
        var divider = document.createElement('div');
        Object.assign(divider.style, {
            height: '1px',
            background: COLORS.border,
            marginBottom: '6px',
        });
        parent.appendChild(divider);

        // Error state
        if (opts.error) {
            var errorEl = document.createElement('div');
            Object.assign(errorEl.style, {
                color: COLORS.errorText,
                fontSize: '12px',
                padding: '8px 0',
                fontStyle: 'italic',
            });
            errorEl.textContent = opts.error;
            parent.appendChild(errorEl);
            return;
        }

        // Empty state
        if (!opts.items || opts.items.length === 0) {
            var emptyEl = document.createElement('div');
            Object.assign(emptyEl.style, {
                color: COLORS.textSecondary,
                fontSize: '12px',
                padding: '8px 0',
                fontStyle: 'italic',
            });
            emptyEl.textContent = opts.emptyMessage;
            parent.appendChild(emptyEl);
            return;
        }

        // Items
        for (var i = 0; i < opts.items.length; i++) {
            var row = opts.renderItem(opts.items[i]);
            parent.appendChild(row);
        }
    }

    function renderLinkRow(number, title, url, dotColor, badge) {
        var row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '5px 6px',
            borderRadius: '4px',
            cursor: 'pointer',
        });
        row.onmouseover = function () { row.style.background = 'rgba(255,255,255,0.05)'; };
        row.onmouseout = function () { row.style.background = 'transparent'; };

        // Color dot
        var dot = document.createElement('span');
        Object.assign(dot.style, {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            display: 'inline-block',
            flexShrink: '0',
            background: dotColor,
        });
        row.appendChild(dot);

        // Number
        var numEl = document.createElement('span');
        Object.assign(numEl.style, {
            fontWeight: '500',
            whiteSpace: 'nowrap',
            fontSize: '12px',
            color: COLORS.textPrimary,
        });
        numEl.textContent = number;
        row.appendChild(numEl);

        // Title
        var titleEl = document.createElement('span');
        Object.assign(titleEl.style, {
            flex: '1',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '12px',
            color: COLORS.textSecondary,
        });
        titleEl.textContent = truncate(title, 50);
        titleEl.title = title;
        row.appendChild(titleEl);

        // Badge (for task type)
        if (badge) {
            var badgeEl = document.createElement('span');
            Object.assign(badgeEl.style, {
                fontSize: '9px',
                background: COLORS.border,
                color: COLORS.textSecondary,
                padding: '1px 5px',
                borderRadius: '8px',
                whiteSpace: 'nowrap',
                flexShrink: '0',
            });
            badgeEl.textContent = badge;
            row.appendChild(badgeEl);
        }

        // Open link icon
        var openIcon = document.createElement('a');
        openIcon.href = url;
        openIcon.target = '_blank';
        openIcon.rel = 'noopener';
        openIcon.textContent = '\u2197';
        Object.assign(openIcon.style, {
            color: COLORS.textSecondary,
            textDecoration: 'none',
            fontSize: '14px',
            flexShrink: '0',
        });
        openIcon.onmouseover = function () { openIcon.style.color = COLORS.textPrimary; };
        openIcon.onmouseout = function () { openIcon.style.color = COLORS.textSecondary; };
        openIcon.title = 'Open in new tab';
        row.appendChild(openIcon);

        // Click on row opens link
        row.onclick = function (e) {
            if (e.target === openIcon || e.target.tagName === 'A') return;
            window.open(url, '_blank');
        };

        return row;
    }

    // ─── Orchestration ──────────────────────────────────────────

    async function initializeReverseLinks() {
        var kbNumber = getKbNumber();
        if (!kbNumber) {
            renderError('Could not detect KB article number.');
            return;
        }
        state.kbNumber = kbNumber;
        state.kbTitle = getArticleTitle();

        if (panelElements) {
            panelElements.titleText.textContent = 'Reverse Links \u2014 ' + kbNumber;
        }

        setLoading(true);
        state.kbError = null;
        state.hyperlinkError = null;
        state.taskError = null;

        // Step 1: Resolve sys_id
        var articleInfo;
        try {
            articleInfo = await resolveArticleSysId(kbNumber);
            state.sysId = articleInfo.sysId;
        } catch (e) {
            setLoading(false);
            if (e.status === 401 || e.status === 403) {
                renderError('Session expired or access denied. Refresh the page.');
            } else {
                renderError('Could not resolve article: ' + e.message);
            }
            return;
        }

        // Step 2: Discover kb_2_kb fields (can fail gracefully)
        var kb2kbFields = null;
        try {
            kb2kbFields = await discoverKb2KbFields();
        } catch (e) {
            state.kbError = 'KB relationship table unavailable (' + (e.status || e.message) + ')';
            console.warn('KB Reverse Links: kb_2_kb discovery failed:', e.message);
        }

        // Step 3: Fetch all three sets of reverse links in parallel
        var kbPromise = kb2kbFields
            ? fetchReverseKbLinks(state.sysId, kb2kbFields.fieldA, kb2kbFields.fieldB)
                .catch(function (e) {
                    state.kbError = 'Could not fetch KB references: ' + e.message;
                    return { links: [], totalCount: 0 };
                })
            : Promise.resolve({ links: [], totalCount: 0 });

        var hyperlinkPromise = fetchReverseHyperlinkRefs(kbNumber)
            .catch(function (e) {
                state.hyperlinkError = 'Could not search article bodies: ' + e.message;
                return { links: [], totalCount: 0 };
            });

        var taskPromise = fetchReverseTaskLinks(state.sysId)
            .catch(function (e) {
                state.taskError = 'Could not fetch task references: ' + e.message;
                return { links: [], totalCount: 0 };
            });

        var results = await Promise.all([kbPromise, hyperlinkPromise, taskPromise]);

        state.reverseKbLinks = results[0].links;
        state.reverseKbTotal = results[0].totalCount;
        state.hyperlinkRefs = results[1].links;
        state.hyperlinkRefsTotal = results[1].totalCount;
        state.reverseTaskLinks = results[2].links;
        state.reverseTaskTotal = results[2].totalCount;
        state.initialized = true;

        setLoading(false);
        renderResults();
    }

    function renderError(message) {
        if (!panelElements) return;
        clearChildren(panelElements.contentArea);
        var el = document.createElement('div');
        Object.assign(el.style, {
            color: COLORS.errorText,
            fontSize: '13px',
            padding: '20px 0',
            textAlign: 'center',
        });
        el.textContent = message;
        panelElements.contentArea.appendChild(el);
        panelElements.contentArea.style.display = 'block';
        panelElements.loading.style.display = 'none';
    }

    async function handleRefresh() {
        state.initialized = false;
        cachedKb2KbFields = null; // re-discover in case schema changed
        await initializeReverseLinks();
    }

    // ─── Toggle Button ──────────────────────────────────────────

    function addToggleButton() {
        if (document.getElementById('kb-reverse-links-btn')) return;

        var btn = document.createElement('button');
        btn.id = 'kb-reverse-links-btn';
        btn.textContent = 'Reverse Links';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '140px',
            right: '20px',
            zIndex: '9999',
            padding: '10px 16px',
            fontSize: '13px',
            fontWeight: '500',
            background: COLORS.accent,
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            transition: 'all 0.2s',
        });

        btn.onmouseover = function () {
            btn.style.background = COLORS.accentHover;
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
        };
        btn.onmouseout = function () {
            btn.style.background = COLORS.accent;
            btn.style.transform = 'translateY(0)';
            btn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
        };

        btn.onclick = async function () {
            showPanel();
            if (!state.initialized) {
                try {
                    await initializeReverseLinks();
                } catch (e) {
                    renderError('Error: ' + e.message);
                    console.error('KB Reverse Links init error:', e);
                }
            }
        };

        document.body.appendChild(btn);
    }

    // ─── Entry Point ────────────────────────────────────────────
    setTimeout(addToggleButton, 3000);
})();
