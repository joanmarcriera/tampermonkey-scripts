// ==UserScript==
// @name         ServiceNow KB List Enricher
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.0
// @description  Enrich KB list view with metrics: in-links, out-links, word count, and malformed links
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
                gap: 8px;
                margin-left: 10px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                vertical-align: middle;
                font-weight: normal;
                color: #94a3b8;
            }
            .${BADGE_CLASS} span {
                display: flex;
                align-items: center;
                gap: 3px;
                padding: 1px 5px;
                background: #1e293b;
                border: 1px solid #334155;
                border-radius: 4px;
            }
            .${BADGE_CLASS} .kb-metric-in { color: #818cf8; }
            .${BADGE_CLASS} .kb-metric-out { color: #34d399; }
            .${BADGE_CLASS} .kb-metric-words { color: #fbbf24; }
            .${BADGE_CLASS} .kb-metric-broken { color: #f87171; border-color: #7f1d1d; }

            /* Highlighting for lean candidates */
            .kb-metric-words.critical { background: #450a0a; color: #f87171; border-color: #991b1b; }
            .kb-metric-in.none { opacity: 0.5; }
        `;
        document.head.appendChild(style);
    }

    async function fetchBatchData(articleIds) {
        if (articleIds.length === 0) return { articles: [], links: [] };

        const articleQuery = 'sys_idIN' + articleIds.join(',');
        const articleUrl = `${window.location.origin}/api/now/table/kb_knowledge?sysparm_query=${encodeURIComponent(articleQuery)}&sysparm_fields=sys_id,number,text,short_description`;

        // Also query kb_2_kb for incoming links (explicit relationships)
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
                // Shallow broken check: missing identifier
                if (!href.includes('sysparm_article=KB') && !href.includes('sys_id=') && !href.includes('sys_kb_id=')) {
                    brokenLinks++;
                }
            } else if (href === '#' || href === '' || href.startsWith('javascript:')) {
                brokenLinks++;
            }
        });

        // Incoming links from kb_2_kb
        const inLinks = allRels.filter(r => {
            const fromId = (typeof r.kb_knowledge === 'object') ? r.kb_knowledge.value : r.kb_knowledge;
            const toId = (typeof r.kb_knowledge_related === 'object') ? r.kb_knowledge_related.value : r.kb_knowledge_related;
            return (fromId === article.sys_id || toId === article.sys_id);
        }).length;

        return { wordCount, outLinks, inLinks, brokenLinks };
    }

    async function enrichList() {
        const anchors = Array.from(document.querySelectorAll('a[href*="sys_kb_id"]:not(.' + ENRICH_CLASS + ')'));
        if (anchors.length === 0) return;

        ensureStyles();

        const idMap = new Map();
        anchors.forEach(a => {
            const url = new URL(a.href, window.location.origin);
            const id = url.searchParams.get('sys_kb_id');
            if (id) {
                if (!idMap.has(id)) idMap.set(id, []);
                idMap.get(id).push(a);
                a.classList.add(ENRICH_CLASS);
            }
        });

        const articleIds = Array.from(idMap.keys());
        if (articleIds.length === 0) return;

        const data = await fetchBatchData(articleIds);

        data.articles.forEach(article => {
            const metrics = processArticle(article, data.links);
            const targets = idMap.get(article.sys_id);
            if (!targets) return;

            targets.forEach(a => {
                const badge = document.createElement('div');
                badge.className = BADGE_CLASS;

                const wordClass = metrics.wordCount < 100 ? 'critical' : '';
                const inClass = metrics.inLinks === 0 ? 'none' : '';

                badge.innerHTML = `
                    <span class="kb-metric-in ${inClass}" title="Incoming links (explicit)">📥 ${metrics.inLinks}</span>
                    <span class="kb-metric-out" title="Outgoing KB links">📤 ${metrics.outLinks}</span>
                    <span class="kb-metric-words ${wordClass}" title="Word count">📝 ${metrics.wordCount}</span>
                    ${metrics.brokenLinks > 0 ? `<span class="kb-metric-broken" title="Malformed/Empty links">❌ ${metrics.brokenLinks}</span>` : ''}
                `;
                a.parentNode.insertBefore(badge, a.nextSibling);
            });
        });
    }

    // Run on load and periodically for dynamic content
    setTimeout(enrichList, 2000);
    setInterval(enrichList, 5000);

})();
