// ==UserScript==
// @name         ServiceNow KB Health Badge
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.1
// @description  Show a quick KB health badge (Fresh, Review Soon, Stale) with owner, state, and version metadata. Supports ESC Portal.
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @match        *://*/esc?id=kb_article*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STYLE_ID = 'kb-health-badge-style';
    const CARD_ID = 'kb-health-badge-card';
    const REFRESH_MS = 30000;
    const MAX_WAIT_TRIES = 30;
    const WAIT_INTERVAL_MS = 500;

    const STATUS = {
        fresh: {
            label: 'Fresh',
            fg: '#14532d',
            bg: '#dcfce7',
            border: '#86efac',
        },
        review: {
            label: 'Review Soon',
            fg: '#78350f',
            bg: '#fef3c7',
            border: '#fcd34d',
        },
        stale: {
            label: 'Stale',
            fg: '#7f1d1d',
            bg: '#fee2e2',
            border: '#fca5a5',
        },
        unknown: {
            label: 'Unknown',
            fg: '#1f2937',
            bg: '#e5e7eb',
            border: '#d1d5db',
        },
    };

    const cache = new Map();

    function normalizeText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function queryText(selector) {
        const el = document.querySelector(selector);
        return el ? normalizeText(el.textContent) : '';
    }

    function queryValue(selector) {
        const el = document.querySelector(selector);
        return el ? normalizeText(el.value) : '';
    }

    function getKbNumber() {
        const readonly = queryText('#articleNumberReadonly');
        const fromReadonly = readonly.match(/\bKB\d+\b/i);
        if (fromReadonly) return fromReadonly[0].toUpperCase();

        const hidden = queryValue('#articleNumber');
        if (/^KB\d+$/i.test(hidden)) return hidden.toUpperCase();

        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get('sysparm_article') || params.get('number');
        if (fromUrl && /^KB\d+$/i.test(fromUrl)) return fromUrl.toUpperCase();

        // Portal specific fallback - sometimes the number is in a span with certain class
        const portalSpan = queryText('.kb-number');
        if (portalSpan && /^KB\d+$/i.test(portalSpan)) return portalSpan.toUpperCase();

        return '';
    }

    function getSysId() {
        const params = new URLSearchParams(window.location.search);
        return params.get('sys_id') || params.get('sysparm_sys_id') || '';
    }

    function getAuthToken() {
        return window.g_ck || '';
    }

    async function fetchMetadata(kbNumber, sysId) {
        const cacheKey = kbNumber || sysId;
        if (cache.has(cacheKey)) return cache.get(cacheKey);

        let query = sysId ? `sys_id=${sysId}` : `number=${kbNumber}`;
        const url = `${window.location.origin}/api/now/table/kb_knowledge?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=short_description,author.name,sys_updated_on,workflow_state,version,number,sys_id&sysparm_limit=1`;

        try {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'X-UserToken': getAuthToken()
                }
            });
            if (!response.ok) return null;
            const data = await response.json();
            if (data.result && data.result.length > 0) {
                const res = data.result[0];
                const meta = {
                    number: res.number,
                    author: res['author.name'] || 'Unknown',
                    updatedOn: res.sys_updated_on,
                    state: res.workflow_state,
                    version: res.version || '1.0'
                };
                cache.set(cacheKey, meta);
                return meta;
            }
        } catch (e) {
            console.error('KB Health Badge API error:', e);
        }
        return null;
    }

    function getOwnerText() {
        const raw = queryText('#articleAuthor') || queryText('.kb-author');
        if (!raw) return '';
        return raw.replace(/^(Revised|Created|Authored)\s+by\s+/i, '').trim() || raw;
    }

    function getVersionText() {
        const displayVersion = queryText('#versionNumber') || queryText('.kb-version');
        if (displayVersion) return displayVersion;

        const rawVersion = queryValue('#articleVersion');
        if (rawVersion) return 'v' + rawVersion;

        return '';
    }

    function getWorkflowState() {
        const state = queryValue('#articleWorkflowState') || queryText('.kb-state');
        return state ? state.toLowerCase() : '';
    }

    function parseRelativeDays(raw) {
        const text = normalizeText(raw).toLowerCase();
        if (!text) return null;

        if (text.includes('today') || text.includes('just now')) return 0;
        if (text.includes('yesterday')) return 1;

        const match = text.match(/(\d+)\s+(minute|hour|day|week|month|year|mo)s?\s+ago/);
        if (!match) return null;

        const count = parseInt(match[1], 10);
        if (!Number.isFinite(count)) return null;

        const unit = match[2];
        if (unit === 'minute' || unit === 'hour') return 0;
        if (unit === 'day') return count;
        if (unit === 'week') return count * 7;
        if (unit === 'month' || unit === 'mo') return count * 30;
        if (unit === 'year') return count * 365;

        return null;
    }

    function estimateLastModifiedDays() {
        const relative = queryText('#articleModifiedLabel') || queryText('.kb-updated');
        const relativeDays = parseRelativeDays(relative);
        if (relativeDays !== null) {
            return { days: relativeDays, label: relative || relativeDays + ' days ago' };
        }
        return { days: null, label: relative || '' };
    }

    function chooseStatus(days, state) {
        if (state === 'retired' || state === 'pending_retirement') return 'stale';
        if (state !== 'published' && state && state !== 'unknown') {
            if (days !== null && days > 180) return 'stale';
            return 'review';
        }
        if (days === null) return 'unknown';
        if (days <= 90) return 'fresh';
        if (days <= 180) return 'review';
        return 'stale';
    }

    function titleCase(text) {
        return String(text || '')
            .split(/[_\s]+/)
            .filter(Boolean)
            .map(function (part) {
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            })
            .join(' ');
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${CARD_ID} {
                position: fixed;
                top: 18px;
                right: 18px;
                z-index: 10005;
                min-width: 240px;
                max-width: 320px;
                background: #0f172a;
                color: #e2e8f0;
                border: 1px solid #334155;
                border-radius: 10px;
                box-shadow: 0 10px 22px rgba(0, 0, 0, 0.35);
                padding: 10px 12px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                line-height: 1.35;
            }
            #${CARD_ID} .kbhb-top {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 10px;
                margin-bottom: 8px;
            }
            #${CARD_ID} .kbhb-title {
                font-weight: 700;
                color: #f8fafc;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #${CARD_ID} .kbhb-status {
                border-radius: 999px;
                border: 1px solid transparent;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 700;
                white-space: nowrap;
            }
            #${CARD_ID} .kbhb-grid {
                display: grid;
                grid-template-columns: auto 1fr;
                gap: 4px 8px;
            }
            #${CARD_ID} .kbhb-k {
                color: #94a3b8;
            }
            #${CARD_ID} .kbhb-v {
                color: #e2e8f0;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
        `;
        document.head.appendChild(style);
    }

    function getOrCreateCard() {
        let card = document.getElementById(CARD_ID);
        if (card) return card;

        card = document.createElement('div');
        card.id = CARD_ID;
        document.body.appendChild(card);
        return card;
    }

    async function renderBadge() {
        let kbNumber = getKbNumber();
        let sysId = getSysId();
        if (!kbNumber && !sysId) return;

        let owner = getOwnerText();
        let version = getVersionText();
        let state = getWorkflowState();
        let modified = estimateLastModifiedDays();

        // If we're missing critical info (common on Portal), fetch from API
        if (!owner || !state || modified.days === null) {
            const apiData = await fetchMetadata(kbNumber, sysId);
            if (apiData) {
                kbNumber = apiData.number || kbNumber;
                owner = apiData.author || owner || 'Unknown';
                version = apiData.version || version || '1.0';
                state = apiData.state || state || 'unknown';

                if (modified.days === null && apiData.updatedOn) {
                    const date = new Date(apiData.updatedOn.replace(' ', 'T'));
                    const diffDays = Math.floor((new Date() - date) / 86400000);
                    modified = { days: diffDays, label: diffDays + ' days ago' };
                }
            }
        }

        const statusKey = chooseStatus(modified.days, state);
        const status = STATUS[statusKey] || STATUS.unknown;
        const safeKb = escapeHtml(kbNumber || 'KB');
        const safeOwner = escapeHtml(owner || 'Unknown');
        const safeModified = escapeHtml(modified.label || 'Unknown');
        const safeVersion = escapeHtml(version || 'Unknown');
        const safeState = escapeHtml(titleCase(state || 'Unknown'));

        ensureStyles();
        const card = getOrCreateCard();
        card.innerHTML = `
            <div class="kbhb-top">
                <div class="kbhb-title">${safeKb} Health</div>
                <div class="kbhb-status"
                    style="color:${status.fg};background:${status.bg};border-color:${status.border};">
                    ${status.label}
                </div>
            </div>
            <div class="kbhb-grid">
                <div class="kbhb-k">Owner</div><div class="kbhb-v" title="${safeOwner}">${safeOwner}</div>
                <div class="kbhb-k">Updated</div><div class="kbhb-v" title="${safeModified}">${safeModified}</div>
                <div class="kbhb-k">Version</div><div class="kbhb-v" title="${safeVersion}">${safeVersion}</div>
                <div class="kbhb-k">State</div><div class="kbhb-v">${safeState}</div>
            </div>
        `;
    }

    function waitForPageAndStart() {
        let tries = 0;
        const timer = setInterval(function () {
            tries += 1;
            if (getKbNumber() || getSysId()) {
                clearInterval(timer);
                renderBadge();
                setInterval(renderBadge, REFRESH_MS);
            } else if (tries >= MAX_WAIT_TRIES) {
                clearInterval(timer);
            }
        }, WAIT_INTERVAL_MS);
    }

    waitForPageAndStart();
})();
