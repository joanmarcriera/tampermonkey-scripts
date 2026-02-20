// ==UserScript==
// @name         ServiceNow KB Content Quality Checker
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.2
// @description  Detects thin content, missing Table of Contents, and readability grade levels. Supports ESC Portal.
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @match        *://*/esc?id=kb_article*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-thin-content-detector.user.js
// @downloadURL  https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-thin-content-detector.user.js
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
        deadEnd: { bg: '#f3e8ff', fg: '#7e22ce', border: '#e9d5ff', label: 'Dead End' },
        missingToc: { bg: '#fee2e2', fg: '#b91c1c', border: '#fecaca', label: 'Missing ToC' },
        simple: { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0', label: 'Simple' },
        average: { bg: '#fef9c3', fg: '#a16207', border: '#fef08a', label: 'Average' },
        complex: { bg: '#ffedd5', fg: '#c2410c', border: '#fed7aa', label: 'Complex' }
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

    function getPlainText(html) {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.innerText || temp.textContent || '';
    }

    function hasNativeToc(html) {
        return html.includes('id="toc"') || html.includes('class="kb-toc"') || html.includes('class="snc-kb-toc"');
    }

    function calculateReadability(html) {
        const text = getPlainText(html);
        const words = text.trim().split(/\s+/).filter(word => word.length > 0);
        const wordCount = words.length;
        if (wordCount === 0) return 0;

        const sentenceCount = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length || 1;

        let syllableCount = 0;
        words.forEach(word => {
            word = word.toLowerCase().replace(/[^a-z]/g, '');
            if (word.length <= 3) syllableCount += 1;
            else {
                word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
                word = word.replace(/^y/, '');
                const syllables = word.match(/[aeiouy]{1,2}/g);
                syllableCount += syllables ? syllables.length : 1;
            }
        });

        // Flesch-Kincaid Grade Level
        return 0.39 * (wordCount / sentenceCount) + 11.8 * (syllableCount / wordCount) - 15.59;
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
        const hasToc = hasNativeToc(content);
        const gradeLevel = calculateReadability(content);

        let status = COLORS.good;
        if (wordCount < CONFIG.critical) status = COLORS.critical;
        else if (wordCount < CONFIG.warning) status = COLORS.warning;
        else if (wordCount < CONFIG.thin) status = COLORS.thin;

        let readabilityStatus = COLORS.simple;
        if (gradeLevel > 12) readabilityStatus = COLORS.complex;
        else if (gradeLevel > 8) readabilityStatus = COLORS.average;

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
            <div class="kb-thin-row">
                <span class="kb-thin-value">Readability (Grade): ${gradeLevel.toFixed(1)}</span>
                <span class="kb-thin-label" style="background:${readabilityStatus.bg}; color:${readabilityStatus.fg}; border:1px solid ${readabilityStatus.border}">${readabilityStatus.label}</span>
            </div>
        `;

        if (wordCount > 500 && !hasToc) {
            html += `
                <div class="kb-thin-row">
                    <span class="kb-thin-value">Structure:</span>
                    <span class="kb-thin-label" style="background:${COLORS.missingToc.bg}; color:${COLORS.missingToc.fg}; border:1px solid ${COLORS.missingToc.border}">${COLORS.missingToc.label}</span>
                </div>
            `;
        }

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
