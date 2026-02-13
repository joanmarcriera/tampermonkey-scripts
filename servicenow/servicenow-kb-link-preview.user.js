// ==UserScript==
// @name         ServiceNow KB Link Preview
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.3
// @description  Show a snippet and health status when hovering over KB article links. Supports sys_id links.
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @match        *://*/esc?id=kb_article*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-link-preview.user.js
// @downloadURL  https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-link-preview.user.js
// ==/UserScript==

(function () {
    'use strict';

    const PREVIEW_ID = 'kb-link-preview-popup';
    const STYLE_ID = 'kb-link-preview-style';
    const FETCH_DELAY = 500; // ms to wait before fetching on hover
    const SNIPPET_LENGTH = 300;

    const COLORS = {
        bg: '#0f172a',
        border: '#334155',
        textPrimary: '#f8fafc',
        textSecondary: '#94a3b8',
        accent: '#7c3aed',
        fresh: { fg: '#14532d', bg: '#dcfce7', border: '#86efac', label: 'Fresh' },
        review: { fg: '#78350f', bg: '#fef3c7', border: '#fcd34d', label: 'Review Soon' },
        stale: { fg: '#7f1d1d', bg: '#fee2e2', border: '#fca5a5', label: 'Stale' },
        unknown: { fg: '#1f2937', bg: '#e5e7eb', border: '#d1d5db', label: 'Unknown' }
    };

    let hoverTimer = null;
    let currentId = null; // Can be KB number or sys_id
    const cache = new Map();

    function getAuthToken() {
        return window.g_ck || '';
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${PREVIEW_ID} {
                position: fixed;
                z-index: 10010;
                width: 350px;
                background: ${COLORS.bg};
                color: ${COLORS.textPrimary};
                border: 1px solid ${COLORS.border};
                border-radius: 8px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.5);
                padding: 12px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                pointer-events: none;
                display: none;
            }
            #${PREVIEW_ID} .kb-preview-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 8px;
                margin-bottom: 8px;
            }
            #${PREVIEW_ID} .kb-preview-title {
                font-weight: 700;
                color: ${COLORS.textPrimary};
                line-height: 1.3;
            }
            #${PREVIEW_ID} .kb-preview-badge {
                font-size: 10px;
                font-weight: 700;
                padding: 1px 6px;
                border-radius: 4px;
                text-transform: uppercase;
                white-space: nowrap;
            }
            #${PREVIEW_ID} .kb-preview-snippet {
                color: ${COLORS.textSecondary};
                line-height: 1.5;
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 5;
                -webkit-box-orient: vertical;
            }
            #${PREVIEW_ID} .kb-preview-snippet b, #${PREVIEW_ID} .kb-preview-snippet strong {
                color: ${COLORS.textPrimary};
            }
            #${PREVIEW_ID} .kb-preview-footer {
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid ${COLORS.border};
                font-size: 11px;
                color: ${COLORS.textSecondary};
                display: flex;
                justify-content: space-between;
            }
        `;
        document.head.appendChild(style);
    }

    function getPopup() {
        let popup = document.getElementById(PREVIEW_ID);
        if (!popup) {
            popup = document.createElement('div');
            popup.id = PREVIEW_ID;
            document.body.appendChild(popup);
        }
        return popup;
    }

    async function fetchArticleData(id) {
        if (cache.has(id)) return cache.get(id);

        let query = id.startsWith('KB') ? `number=${id}` : `sys_id=${id}`;
        const url = `${window.location.origin}/api/now/table/kb_knowledge?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=short_description,text,workflow_state,sys_updated_on,number,sys_id&sysparm_limit=1`;

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
                const article = data.result[0];
                cache.set(id, article);
                // Also cache by the other identifier if available
                if (article.number) cache.set(article.number, article);
                if (article.sys_id) cache.set(article.sys_id, article);
                return article;
            }
        } catch (e) {
            console.error('KB Preview fetch error:', e);
        }
        return null;
    }

    function calculateHealth(updatedOn, state) {
        if (state === 'retired' || state === 'pending_retirement') return COLORS.stale;

        if (!updatedOn) return COLORS.unknown;
        const updatedDate = new Date(updatedOn.replace(' ', 'T'));
        if (isNaN(updatedDate.getTime())) return COLORS.unknown;

        const now = new Date();
        const diffDays = Math.floor((now - updatedDate) / (1000 * 60 * 60 * 24));

        if (state !== 'published') return COLORS.review;
        if (diffDays <= 90) return COLORS.fresh;
        if (diffDays <= 180) return COLORS.review;
        return COLORS.stale;
    }

    function cleanHtml(html) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const allowedTags = ['B', 'STRONG', 'I', 'EM'];

        function process(node) {
            const children = Array.from(node.childNodes);
            for (const child of children) {
                if (child.nodeType === 1) { // Element
                    if (allowedTags.includes(child.tagName)) {
                        while (child.attributes && child.attributes.length > 0) {
                            child.removeAttribute(child.attributes[0].name);
                        }
                        process(child);
                    } else {
                        process(child);
                        while (child.firstChild) {
                            node.insertBefore(child.firstChild, child);
                        }
                        node.removeChild(child);
                    }
                }
            }
        }

        process(tempDiv);
        let cleaned = tempDiv.innerHTML;
        if (cleaned.length > SNIPPET_LENGTH) {
            cleaned = cleaned.substring(0, SNIPPET_LENGTH) + '...';
        }
        return cleaned;
    }

    function showPopup(e, article) {
        const popup = getPopup();
        ensureStyles();

        const health = calculateHealth(article.sys_updated_on, article.workflow_state);
        const cleanedSnippet = cleanHtml(article.text);

        popup.innerHTML = `
            <div class="kb-preview-header">
                <div class="kb-preview-title"></div>
                <div class="kb-preview-badge" style="color:${health.fg}; background:${health.bg}; border: 1px solid ${health.border}">${health.label}</div>
            </div>
            <div class="kb-preview-snippet">${cleanedSnippet}</div>
            <div class="kb-preview-footer">
                <span>${article.number || ''}</span>
                <span>State: ${article.workflow_state || 'unknown'}</span>
            </div>
        `;

        popup.querySelector('.kb-preview-title').textContent = article.short_description || 'No Title';

        const x = e.clientX + 15;
        const y = e.clientY + 15;

        popup.style.left = `${x}px`;
        popup.style.top = `${y}px`;
        popup.style.display = 'block';

        const rect = popup.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            popup.style.left = `${window.innerWidth - rect.width - 20}px`;
        }
        if (rect.bottom > window.innerHeight) {
            popup.style.top = `${e.clientY - rect.height - 20}px`;
        }
    }

    function hidePopup() {
        const popup = document.getElementById(PREVIEW_ID);
        if (popup) popup.style.display = 'none';
        clearTimeout(hoverTimer);
        currentId = null;
    }

    function attachListeners() {
        document.addEventListener('mouseover', async (e) => {
            const anchor = e.target.closest('a');
            if (!anchor) return;

            const href = anchor.getAttribute('href');
            if (!href) return;

            let kbId = null;
            try {
                const url = new URL(href, window.location.origin);
                const kbNum = url.searchParams.get('sysparm_article') || url.searchParams.get('number');
                const sysId = url.searchParams.get('sys_id') || url.searchParams.get('sysparm_sys_id');
                const pageId = url.searchParams.get('id');

                if (kbNum && /^KB\d+$/.test(kbNum)) {
                    kbId = kbNum;
                } else if (sysId && (pageId === 'kb_article' || url.pathname.includes('kb_article'))) {
                    kbId = sysId;
                } else if (url.pathname.includes('kb_view.do') || url.pathname.includes('kb_article')) {
                    const match = anchor.innerText.match(/\bKB\d+\b/);
                    if (match) kbId = match[0];
                }
            } catch (err) {}

            if (kbId) {
                currentId = kbId;
                hoverTimer = setTimeout(async () => {
                    if (currentId === kbId) {
                        const article = await fetchArticleData(kbId);
                        if (article && currentId === kbId) {
                            showPopup(e, article);
                        }
                    }
                }, FETCH_DELAY);
            }
        });

        document.addEventListener('mouseout', (e) => {
            const anchor = e.target.closest('a');
            if (anchor) hidePopup();
        });
    }

    attachListeners();
})();
