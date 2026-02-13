// ==UserScript==
// @name         ServiceNow KB Thin Content Detector
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.1
// @description  Detects "thin" articles and "dead ends" (no outgoing links) to help lean out documentation. Supports ESC Portal.
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @match        *://*/esc?id=kb_article*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const BADGE_ID = 'kb-thin-content-badge';
    const STYLE_ID = 'kb-thin-content-style';

    const CONFIG = {
        critical: 100,
        warning: 200,
        thin: 300
    };

    const COLORS = {
        critical: { bg: '#fee2e2', fg: '#b91c1c', border: '#fecaca', label: 'Critical Noise' },
        warning: { bg: '#ffedd5', fg: '#c2410c', border: '#fed7aa', label: 'Very Thin' },
        thin: { bg: '#fef9c3', fg: '#a16207', border: '#fef08a', label: 'Thin Content' },
        good: { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0', label: 'Good Length' },
        deadEnd: { bg: '#f3e8ff', fg: '#7e22ce', border: '#e9d5ff', label: 'Dead End' }
    };

    function getArticleContent() {
        // Backend view
        const original = document.getElementById('articleOriginal');
        if (original && original.value) return original.value;

        const article = document.getElementById('article');
        if (article && article.innerHTML) return article.innerHTML;

        // Portal view
        const portalContent = document.querySelector('.kb-article-content') ||
                            document.querySelector('.kb-article-body') ||
                            document.querySelector('article .kb-content') ||
                            document.querySelector('.article-content');
        if (portalContent && portalContent.innerHTML) return portalContent.innerHTML;

        return '';
    }

    function countWords(html) {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        const text = temp.innerText || temp.textContent || '';
        return text.trim().split(/\s+/).filter(word => word.length > 0).length;
    }

    function hasOutgoingKbLinks(html) {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        const anchors = temp.querySelectorAll('a[href]');
        for (const a of anchors) {
            const href = a.getAttribute('href');
            if (href && (href.includes('kb_view.do') || href.includes('kb_article') || href.includes('sysparm_article=KB'))) {
                return true;
            }
        }
        return false;
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${BADGE_ID} {
                position: fixed;
                bottom: 20px;
                left: 20px;
                z-index: 10006;
                background: #0f172a;
                color: #e2e8f0;
                border: 1px solid #334155;
                border-radius: 8px;
                padding: 10px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                display: flex;
                flex-direction: column;
                gap: 6px;
                min-width: 150px;
            }
            #${BADGE_ID} .kb-thin-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 10px;
            }
            #${BADGE_ID} .kb-thin-label {
                font-weight: 700;
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 10px;
                text-transform: uppercase;
            }
            #${BADGE_ID} .kb-thin-value {
                color: #94a3b8;
            }
        `;
        document.head.appendChild(style);
    }

    function renderDetector() {
        const content = getArticleContent();
        if (!content) return;

        const wordCount = countWords(content);
        const isDeadEnd = !hasOutgoingKbLinks(content);

        let status = COLORS.good;
        if (wordCount < CONFIG.critical) status = COLORS.critical;
        else if (wordCount < CONFIG.warning) status = COLORS.warning;
        else if (wordCount < CONFIG.thin) status = COLORS.thin;

        ensureStyles();
        let badge = document.getElementById(BADGE_ID);
        if (!badge) {
            badge = document.createElement('div');
            badge.id = BADGE_ID;
            document.body.appendChild(badge);
        }

        let html = `
            <div class="kb-thin-row">
                <span class="kb-thin-value">Word Count: ${wordCount}</span>
                <span class="kb-thin-label" style="background:${status.bg}; color:${status.fg}; border:1px solid ${status.border}">${status.label}</span>
            </div>
        `;

        if (isDeadEnd) {
            html += `
                <div class="kb-thin-row">
                    <span class="kb-thin-value">Navigation:</span>
                    <span class="kb-thin-label" style="background:${COLORS.deadEnd.bg}; color:${COLORS.deadEnd.fg}; border:1px solid ${COLORS.deadEnd.border}">${COLORS.deadEnd.label}</span>
                </div>
            `;
        }

        badge.innerHTML = html;
    }

    // Wait for content to load
    setTimeout(renderDetector, 3000);
})();
