// ==UserScript==
// @name         ServiceNow KB Content Merger (Editor Helper)
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.1
// @description  Adds a "Copy Content" button next to KB links in the editor to facilitate merging articles
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_knowledge.do*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-content-merger.user.js
// @downloadURL  https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-content-merger.user.js
// ==/UserScript==

(function () {
    'use strict';

    const BUTTON_CLASS = 'kb-merger-copy-btn';
    const STYLE_ID = 'kb-merger-style';

    function getAuthToken() {
        return window.g_ck || '';
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${BUTTON_CLASS} {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 20px;
                margin-left: 6px;
                background: #7c3aed;
                color: white;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                border: none;
                vertical-align: middle;
                transition: background 0.2s;
            }
            .${BUTTON_CLASS}:hover {
                background: #6d28d9;
            }
            .${BUTTON_CLASS}:active {
                background: #4c1d95;
            }
            .${BUTTON_CLASS}.copied {
                background: #059669;
            }
        `;
        document.head.appendChild(style);
    }

    async function copyArticleContent(kbNumber, btn) {
        const url = `${window.location.origin}/api/now/table/kb_knowledge?sysparm_query=number=${kbNumber}&sysparm_fields=text&sysparm_limit=1`;

        try {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'X-UserToken': getAuthToken()
                }
            });
            if (!response.ok) throw new Error('Fetch failed');
            const data = await response.json();
            if (data.result && data.result.length > 0) {
                const content = data.result[0].text;
                await navigator.clipboard.writeText(content);

                // Visual feedback
                const originalText = btn.textContent;
                btn.textContent = '✓';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.classList.remove('copied');
                }, 2000);
            }
        } catch (e) {
            console.error('KB Merger copy error:', e);
            btn.textContent = '×';
            setTimeout(() => { btn.textContent = '📋'; }, 2000);
        }
    }

    function addButtons() {
        const anchors = document.querySelectorAll('a:not(.' + BUTTON_CLASS + '-parent)');
        anchors.forEach(a => {
            const href = a.getAttribute('href');
            if (!href) return;

            let kbNumber = null;
            try {
                const url = new URL(href, window.location.origin);
                kbNumber = url.searchParams.get('sysparm_article') || url.searchParams.get('number');
                if (!kbNumber && (url.pathname.includes('kb_view.do') || url.pathname.includes('kb_article'))) {
                    const match = a.innerText.match(/\bKB\d+\b/);
                    if (match) kbNumber = match[0];
                }
            } catch (e) {}

            if (kbNumber && /^KB\d+$/.test(kbNumber)) {
                a.classList.add(BUTTON_CLASS + '-parent');
                const btn = document.createElement('button');
                btn.className = BUTTON_CLASS;
                btn.textContent = '📋';
                btn.title = 'Copy Clean HTML content of ' + kbNumber;
                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    copyArticleContent(kbNumber, btn);
                };
                a.parentNode.insertBefore(btn, a.nextSibling);
            }
        });
    }

    // Run periodically to catch dynamic links
    ensureStyles();
    setInterval(addButtons, 3000);
})();
