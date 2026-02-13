// ==UserScript==
// @name         ServiceNow KB List Enricher
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.3
// @description  Enrich KB list view with metrics: in-links, out-links, word count, and malformed links. Handles dynamic Angular content.
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/$knowledge.do*
// @match        *://*/%24knowledge.do*
// @match        *://*/kb_knowledge_home.do*
// @match        *://*/kb_home.do*
// @match        *://*/kb_find.do*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-list-enricher.user.js
// @downloadURL  https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/servicenow-kb-list-enricher.user.js
// ==/UserScript==

(function () {
    'use strict';

    console.log('KB Enricher: Script loaded on ' + window.location.href);

    const ENRICH_CLASS = 'kb-list-enriched';
    const BADGE_CLASS = 'kb-enricher-badge';
    const STYLE_ID = 'kb-enricher-style';

    const CONFIG = {
        CHUNK_SIZE: 50,
        DEBOUNCE_MS: 500,
        THIN_CONTENT_THRESHOLD: 100,
        INITIAL_DELAY_MS: 2000,
    };

    const LINK_SELECTORS = [
        'a[href*="sys_kb_id"]',
        'a[href*="kb_view.do"]',
        'a[href*="kb_article.do"]',
        'a[href*="sysparm_article"]',
        'a[href*="id=kb_article"]',
    ];

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

    function chunkArray(items, size) {
        const chunks = [];
        for (let i = 0; i < items.length; i += size) {
            chunks.push(items.slice(i, i + size));
        }
        return chunks;
    }

    async function fetchBatchData(articleIds, kbNumbers) {
        if (articleIds.length === 0 && kbNumbers.length === 0) return { articles: [], links: [] };

        const allArticles = [];
        const headers = { 'Accept': 'application/json', 'X-UserToken': getAuthToken() };

        // Fetch articles in chunks to avoid URL length limits
        const idChunks = chunkArray(articleIds, CONFIG.CHUNK_SIZE);
        const kbChunks = chunkArray(kbNumbers, CONFIG.CHUNK_SIZE);
        const maxLen = Math.max(idChunks.length, kbChunks.length);

        for (let i = 0; i < maxLen; i++) {
            let articleQuery = '';
            const ids = idChunks[i] || [];
            const kbs = kbChunks[i] || [];
            if (ids.length > 0) articleQuery += 'sys_idIN' + ids.join(',');
            if (kbs.length > 0) {
                if (articleQuery) articleQuery += '^OR';
                articleQuery += 'numberIN' + kbs.join(',');
            }
            if (!articleQuery) continue;

            try {
                const url = `${window.location.origin}/api/now/table/kb_knowledge?sysparm_query=${encodeURIComponent(articleQuery)}&sysparm_fields=sys_id,number,text,short_description`;
                const resp = await fetch(url, { headers });
                if (resp.ok) {
                    const data = await resp.json();
                    allArticles.push(...(data.result || []));
                } else {
                    console.warn('KB Enricher: Article fetch returned ' + resp.status);
                }
            } catch (e) {
                console.error('KB Enricher: Article chunk fetch error:', e);
            }
        }

        if (allArticles.length === 0) return { articles: [], links: [] };

        // Fetch relationships in chunks
        const allSysIds = allArticles.map(a => a.sys_id);
        const sysIdChunks = chunkArray(allSysIds, CONFIG.CHUNK_SIZE);
        const allLinks = [];

        for (const chunk of sysIdChunks) {
            try {
                const relQuery = 'kb_knowledgeIN' + chunk.join(',') + '^ORkb_knowledge_relatedIN' + chunk.join(',');
                const url = `${window.location.origin}/api/now/table/kb_2_kb?sysparm_query=${encodeURIComponent(relQuery)}&sysparm_fields=kb_knowledge,kb_knowledge_related`;
                const resp = await fetch(url, { headers });
                if (resp.ok) {
                    const data = await resp.json();
                    allLinks.push(...(data.result || []));
                } else {
                    console.warn('KB Enricher: Relationship fetch returned ' + resp.status);
                }
            } catch (e) {
                console.error('KB Enricher: Relationship chunk fetch error:', e);
            }
        }

        return { articles: allArticles, links: allLinks };
    }

    function processArticle(article, allRels) {
        const temp = document.createElement('div');
        temp.innerHTML = article.text || ''; // Safe: parsing ServiceNow API response in detached element

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
            const id = url.searchParams.get('sys_kb_id')
                || url.searchParams.get('sys_id')
                || url.searchParams.get('sysparm_article');
            if (id) return id;
            // Fallback: extract KB number from link text
            const match = (a.textContent || '').match(/\bKB\d{7,}\b/);
            if (match) return match[0];
        } catch (e) {
            // Invalid URL
        }
        return null;
    }

    function buildSelector() {
        return LINK_SELECTORS.map(s => s + ':not(.' + ENRICH_CLASS + ')').join(', ');
    }

    function createBadge(metrics) {
        const badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        const wordClass = metrics.wordCount < CONFIG.THIN_CONTENT_THRESHOLD ? 'critical' : '';

        const inSpan = Object.assign(document.createElement('span'), { className: 'kb-metric-in', title: 'Incoming links (explicit)', textContent: '\u{1F4E5} ' + metrics.inLinks });
        const outSpan = Object.assign(document.createElement('span'), { className: 'kb-metric-out', title: 'Outgoing KB links', textContent: '\u{1F4E4} ' + metrics.outLinks });
        const wordSpan = Object.assign(document.createElement('span'), { className: 'kb-metric-words ' + wordClass, title: 'Word count', textContent: '\u{1F4DD} ' + metrics.wordCount });

        badge.appendChild(inSpan);
        badge.appendChild(outSpan);
        badge.appendChild(wordSpan);

        if (metrics.brokenLinks > 0) {
            const brokenSpan = Object.assign(document.createElement('span'), { className: 'kb-metric-broken', title: 'Malformed/Empty links', textContent: '\u274C ' + metrics.brokenLinks });
            badge.appendChild(brokenSpan);
        }

        return badge;
    }

    let isRunning = false;
    let pendingRecheck = false;

    async function enrichList() {
        if (isRunning) {
            pendingRecheck = true;
            return;
        }

        const selector = buildSelector();
        const anchors = Array.from(document.querySelectorAll(selector));

        if (anchors.length === 0) return;

        console.log('KB Enricher: Found ' + anchors.length + ' new links to process.');
        isRunning = true;

        try {
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
                }
                a.classList.add(ENRICH_CLASS);
            });

            if (articleIds.length === 0 && kbNumbers.length === 0) {
                console.log('KB Enricher: Found anchors but could not extract IDs from any.');
                return;
            }

            const data = await fetchBatchData(articleIds, kbNumbers);
            console.log('KB Enricher: Fetched data for ' + data.articles.length + ' articles.');

            data.articles.forEach(article => {
                const metrics = processArticle(article, data.links);
                const targets = (idMap.get(article.sys_id) || []).concat(idMap.get(article.number) || []);
                if (targets.length === 0) return;

                const uniqueTargets = [...new Set(targets)];

                uniqueTargets.forEach(a => {
                    if (a.nextSibling && a.nextSibling.classList && a.nextSibling.classList.contains(BADGE_CLASS)) return;
                    a.parentNode.insertBefore(createBadge(metrics), a.nextSibling);
                });
            });
        } catch (e) {
            console.error('KB Enricher: Error during enrichment:', e);
        } finally {
            isRunning = false;
            if (pendingRecheck) {
                pendingRecheck = false;
                scheduleEnrich();
            }
        }
    }

    // Debounced scheduling to avoid rapid-fire calls during Angular rendering
    let debounceTimer = null;

    function scheduleEnrich() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(enrichList, CONFIG.DEBOUNCE_MS);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                scheduleEnrich();
                return;
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial run with longer delay for Angular bootstrap
    setTimeout(scheduleEnrich, CONFIG.INITIAL_DELAY_MS);

})();
