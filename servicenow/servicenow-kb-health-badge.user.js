// ==UserScript==
// @name         ServiceNow KB Health Badge
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.0
// @description  Show a quick KB health badge (Fresh, Review Soon, Stale) with owner, state, and version metadata
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

        return '';
    }

    function getOwnerText() {
        const raw = queryText('#articleAuthor');
        if (!raw) return 'Unknown';
        return raw.replace(/^(Revised|Created|Authored)\s+by\s+/i, '').trim() || raw;
    }

    function getVersionText() {
        const displayVersion = queryText('#versionNumber');
        if (displayVersion) return displayVersion;

        const rawVersion = queryValue('#articleVersion');
        if (rawVersion) return 'v' + rawVersion;

        return 'Unknown';
    }

    function getWorkflowState() {
        const state = queryValue('#articleWorkflowState');
        return state ? state.toLowerCase() : 'unknown';
    }

    function parseRelativeDays(raw) {
        const text = normalizeText(raw).toLowerCase();
        if (!text) return null;

        if (text.includes('today') || text.includes('just now')) return 0;
        if (text.includes('yesterday')) return 1;

        const match = text.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
        if (!match) return null;

        const count = parseInt(match[1], 10);
        if (!Number.isFinite(count)) return null;

        const unit = match[2];
        if (unit === 'minute' || unit === 'hour') return 0;
        if (unit === 'day') return count;
        if (unit === 'week') return count * 7;
        if (unit === 'month') return count * 30;
        if (unit === 'year') return count * 365;

        return null;
    }

    function parseDaysFromVersionHistory() {
        const text = queryText('#versions-list b');
        if (!text) return null;

        const dateMatch = text.match(/(Last modified on|Created on)\s+(\d{4}-\d{2}-\d{2})/i);
        if (!dateMatch) return null;

        const date = new Date(dateMatch[2] + 'T00:00:00');
        if (Number.isNaN(date.getTime())) return null;

        const now = new Date();
        const days = Math.floor((now.getTime() - date.getTime()) / 86400000);
        return Math.max(0, days);
    }

    function estimateLastModifiedDays() {
        const relative = queryText('#articleModifiedLabel');
        const relativeDays = parseRelativeDays(relative);
        if (relativeDays !== null) {
            return { days: relativeDays, label: relative || relativeDays + ' days ago' };
        }

        const historyDays = parseDaysFromVersionHistory();
        if (historyDays !== null) {
            return { days: historyDays, label: historyDays + ' days ago' };
        }

        return { days: null, label: relative || 'Unknown' };
    }

    function chooseStatus(days, state) {
        if (state === 'retired' || state === 'pending_retirement') return 'stale';
        if (state !== 'published' && state !== 'unknown') {
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

    function renderBadge() {
        const kbNumber = getKbNumber();
        if (!kbNumber) return;

        const owner = getOwnerText();
        const version = getVersionText();
        const state = getWorkflowState();
        const modified = estimateLastModifiedDays();
        const statusKey = chooseStatus(modified.days, state);
        const status = STATUS[statusKey] || STATUS.unknown;
        const safeKb = escapeHtml(kbNumber);
        const safeOwner = escapeHtml(owner);
        const safeModified = escapeHtml(modified.label);
        const safeVersion = escapeHtml(version);
        const safeState = escapeHtml(titleCase(state));

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
            if (getKbNumber()) {
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
