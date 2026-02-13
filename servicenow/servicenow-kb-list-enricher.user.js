// ==UserScript==
// @name         ServiceNow KB List Enricher
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.1
// @description  Enrich KB list view with metrics: in-links, out-links, word count, and malformed links. Handles dynamic Angular content.
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/$knowledge.do*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-list-enricher.user.js
// @downloadURL  https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-list-enricher.user.js
// ==/UserScript==

(function () {
    'use strict';

    const ENRICH_CLASS = 'kb-list-enriched';
    const BADGE_CLASS = 'kb-enricher-badge';
    const STYLE_ID = 'kb-enricher-style';

    function getAuthToken() {
        return window.g_ck || '';
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${BADGE_CLASS} {
                display: inline-flex;
                gap: 6px;
                margin-left: 8px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 10px;
                vertical-align: middle;
                font-weight: normal;
            }
            .${BADGE_CLASS} span {
                display: flex;
                align-items: center;
                gap: 2px;
                padding: 1px 4px;
                background: #f1f5f9;
                border: 1px solid #cbd5e1;
                border-radius: 3px;
                color: #475569;
            }
            .${BADGE_CLASS} .kb-metric-in { color: #4338ca; border-color: #c7d2fe; background: #e0e7ff; }
            .${BADGE_CLASS} .kb-metric-out { color: #065f46; border-color: #a7f3d0; background: #ecfdf5; }
            .${BADGE_CLASS} .kb-metric-words { color: #92400e; border-color: #fde68a; background: #fffbeb; }
            .${BADGE_CLASS} .kb-metric-broken { color: #991b1b; border-color: #fecaca; background: #fef2f2; }

            .kb-metric-words.critical { background: #fee2e2; color: #b91c1c; border-color: #fca5a5; font-weight: bold; }
        `;
        document.head.appendChild(style);
    }

    async function fetchBatchData(articleIds) {
        if (articleIds.length === 0) return { articles: [], links: [] };

        const articleQuery = 'sys_idIN' + articleIds.join(',');
        const articleUrl = `${window.location.origin}/api/now/table/kb_knowledge?sysparm_query=${encodeURIComponent(articleQuery)}&sysparm_fields=sys_id,number,text,short_description`;

        const relQuery = 'kb_knowledgeIN' + articleIds.join(',') + '^ORkb_knowledge_relatedIN' + articleIds.join(',');
        const relUrl = `${window.location.origin}/api/now/table/kb_2_kb?sysparm_query=${encodeURIComponent(relQuery)}&sysparm_fields=kb_knowledge,kb_knowledge_related`;

        try {
            const [artResp, relResp] = await Promise.all([
                fetch(articleUrl, { headers: { 'Accept': 'application/json', 'X-UserToken': getAuthToken() } }),
                fetch(relUrl, { headers: { 'Accept': 'application/json', 'X-UserToken': getAuthToken() } })
            ]);

            const artData = artResp.ok ? await artResp.json() : { result: [] };
            const relData = relResp.ok ? await relResp.json() : { result: [] };

            return {
                articles: artData.result || [],
                links: relData.result || []
            };
        } catch (e) {
            console.error('KB Enricher fetch error:', e);
            return { articles: [], links: [] };
        }
    }

    function processArticle(article, allRels) {
        const temp = document.createElement('div');
        temp.innerHTML = article.text || '';

        const plainText = temp.innerText || temp.textContent || '';
        const wordCount = plainText.trim().split(/\s+/).filter(w => w.length > 0).length;

        const anchors = Array.from(temp.querySelectorAll('a[href]'));
        let outLinks = 0;
        let brokenLinks = 0;

        anchors.forEach(a => {
            const href = a.getAttribute('href') || '';
            if (href.includes('kb_view.do') || href.includes('kb_article') || href.includes('sysparm_article=KB')) {
                outLinks++;
                if (!href.includes('sysparm_article=KB') && !href.includes('sys_id=') && !href.includes('sys_kb_id=')) {
                    brokenLinks++;
                }
            } else if (href === '#' || href === '' || href.startsWith('javascript:')) {
                brokenLinks++;
            }
        });

        const inLinks = allRels.filter(r => {
            const fromId = (typeof r.kb_knowledge === 'object') ? r.kb_knowledge.value : r.kb_knowledge;
            const toId = (typeof r.kb_knowledge_related === 'object') ? r.kb_knowledge_related.value : r.kb_knowledge_related;
            return (fromId === article.sys_id || toId === article.sys_id);
        }).length;

        return { wordCount, outLinks, inLinks, brokenLinks };
    }

    function extractIdFromLink(a) {
        try {
            const url = new URL(a.href, window.location.origin);
            return url.searchParams.get('sys_kb_id') || url.searchParams.get('sys_id') || url.searchParams.get('sysparm_article');
        } catch (e) {
            return null;
        }
    }

    let isRunning = false;
    async function enrichList() {
        if (isRunning) return;

        // Match Knowledge list links. They typically have sys_kb_id or lead to kb_view.do
        const selector = 'a[href*="sys_kb_id"]:not(.' + ENRICH_CLASS + '), a[href*="kb_view.do"]:not(.' + ENRICH_CLASS + ')';
        const anchors = Array.from(document.querySelectorAll(selector));

        if (anchors.length === 0) return;
        console.log('KB Enricher: Found ' + anchors.length + ' new links to process.');
        isRunning = true;

        ensureStyles();

        const idMap = new Map();
        const articleIds = [];
        const kbNumbers = [];

        anchors.forEach(a => {
            const id = extractIdFromLink(a);
            if (id) {
                if (!idMap.has(id)) {
                    idMap.set(id, []);
                    if (id.startsWith('KB')) kbNumbers.push(id);
                    else articleIds.push(id);
                }
                idMap.get(id).push(a);
                a.classList.add(ENRICH_CLASS);
            }
        });

        if (articleIds.length === 0 && kbNumbers.length === 0) {
            isRunning = false;
            return;
        }

        // We primarily use sys_id for batch fetching. If we have KB numbers, we'd need to resolve them or query by number.
        // On $knowledge.do, they are almost always sys_kb_id.
        const data = await fetchBatchData(articleIds);
        console.log('KB Enricher: Fetched data for ' + data.articles.length + ' articles.');

        data.articles.forEach(article => {
            const metrics = processArticle(article, data.links);
            const targets = idMap.get(article.sys_id);
            if (!targets) return;

            targets.forEach(a => {
                // Ensure we haven't added it already (check sibling)
                if (a.nextSibling && a.nextSibling.classList && a.nextSibling.classList.contains(BADGE_CLASS)) return;

                const badge = document.createElement('div');
                badge.className = BADGE_CLASS;

                const wordClass = metrics.wordCount < 100 ? 'critical' : '';

                badge.innerHTML = `
                    <span class="kb-metric-in" title="Incoming links (explicit)">📥 ${metrics.inLinks}</span>
                    <span class="kb-metric-out" title="Outgoing KB links">📤 ${metrics.outLinks}</span>
                    <span class="kb-metric-words ${wordClass}" title="Word count">📝 ${metrics.wordCount}</span>
                    ${metrics.brokenLinks > 0 ? `<span class="kb-metric-broken" title="Malformed/Empty links">❌ ${metrics.brokenLinks}</span>` : ''}
                `;
                a.parentNode.insertBefore(badge, a.nextSibling);
            });
        });

        isRunning = false;
    }

    // Use MutationObserver to watch for Angular rendering content
    const observer = new MutationObserver((mutations) => {
        let shouldRun = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldRun = true;
                break;
            }
        }
        if (shouldRun) {
            enrichList();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial run
    setTimeout(enrichList, 2000);

})();
