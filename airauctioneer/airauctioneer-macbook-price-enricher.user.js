// ==UserScript==
// @name         AirAuctioneer MacBook Price Enricher
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.0
// @description  Shows estimated market value and specs for MacBook items on AirAuctioneer auction pages
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://airauctioneer.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/airauctioneer/airauctioneer-macbook-price-enricher.user.js
// @downloadURL  https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/airauctioneer/airauctioneer-macbook-price-enricher.user.js
// ==/UserScript==

(function () {
    'use strict';

    const ENRICHED_CLASS = 'macbook-price-enriched';
    const BADGE_CLASS = 'macbook-price-badge';
    const STYLE_ID = 'macbook-price-style';

    // Estimated UK market prices (GBP) as of Feb 2026.
    // Format: 'model-key': { 'RAM_GB-SSD_GB': [low, high] }
    // Sources: Mac4Sale, eBay UK, Back Market UK, Gadcet UK.
    const PRICE_TABLE = {
        'macbook-pro-13-2016': {
            '8-256':   [130, 200],
            '16-256':  [160, 240],
            '16-512':  [180, 280],
        },
        'macbook-pro-13-2017': {
            '8-128':   [140, 210],
            '8-256':   [170, 250],
            '16-256':  [200, 310],
            '16-512':  [230, 340],
        },
        'macbook-pro-13-2018': {
            '8-256':   [220, 320],
            '16-256':  [260, 380],
            '16-512':  [300, 420],
            '16-1024': [350, 480],
        },
        'macbook-pro-13-2019': {
            '8-256':   [250, 360],
            '16-256':  [290, 420],
            '16-512':  [330, 460],
            '16-1024': [380, 520],
        },
        'macbook-pro-15-2016': {
            '16-256':  [200, 320],
            '16-512':  [250, 380],
        },
        'macbook-pro-15-2017': {
            '16-256':  [250, 380],
            '16-512':  [300, 440],
        },
        'macbook-pro-15-2018': {
            '16-256':  [320, 460],
            '16-512':  [380, 540],
            '32-256':  [400, 560],
            '32-512':  [450, 620],
            '32-1024': [500, 700],
        },
        'macbook-pro-15-2019': {
            '16-256':  [380, 520],
            '16-512':  [430, 600],
            '32-512':  [500, 680],
            '32-1024': [580, 780],
        },
        'macbook-pro-16-2019': {
            '16-512':  [480, 650],
            '16-1024': [550, 740],
            '32-1024': [650, 850],
            '64-1024': [750, 950],
        },
        'macbook-air-13-2017': {
            '8-128':   [120, 180],
            '8-256':   [150, 220],
        },
        'macbook-air-13-2018': {
            '8-128':   [160, 240],
            '8-256':   [190, 280],
            '16-256':  [220, 320],
        },
        'macbook-air-13-2019': {
            '8-128':   [180, 270],
            '8-256':   [210, 310],
            '16-256':  [250, 360],
        },
        'macbook-air-13-2020': {
            '8-256':   [280, 400],
            '8-512':   [330, 460],
            '16-256':  [320, 440],
            '16-512':  [370, 510],
        },
    };

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${BADGE_CLASS} {
                margin-top: 6px;
                padding: 6px 8px;
                background: #f0fdf4;
                border: 1px solid #86efac;
                border-radius: 6px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px;
                line-height: 1.4;
                color: #14532d;
            }
            .${BADGE_CLASS} .mp-specs {
                color: #475569;
                font-size: 10px;
                margin-bottom: 3px;
            }
            .${BADGE_CLASS} .mp-price {
                font-weight: 600;
                font-size: 12px;
                color: #15803d;
            }
            .${BADGE_CLASS} .mp-price-unknown {
                font-weight: 600;
                font-size: 12px;
                color: #b45309;
            }
            .${BADGE_CLASS} .mp-links {
                margin-top: 3px;
                font-size: 9px;
            }
            .${BADGE_CLASS} .mp-links a {
                color: #2563eb;
                text-decoration: none;
                margin-right: 8px;
            }
            .${BADGE_CLASS} .mp-links a:hover {
                text-decoration: underline;
            }
            .${BADGE_CLASS} .mp-loading {
                color: #94a3b8;
                font-style: italic;
            }
            .${BADGE_CLASS} .mp-error {
                color: #dc2626;
                font-size: 10px;
            }
        `;
        document.head.appendChild(style);
    }

    // Parse model key from title text, e.g. "#001 MacBook Pro 13-inch Retina (Mid 2017)" -> "macbook-pro-13-2017"
    function parseModelFromTitle(titleText) {
        const clean = titleText.replace(/#\d+\s*/, '').trim().toLowerCase();

        let family = 'macbook';
        if (/macbook\s*pro/.test(clean)) family = 'macbook-pro';
        else if (/macbook\s*air/.test(clean)) family = 'macbook-air';

        // Extract screen size
        let size = '';
        const sizeMatch = clean.match(/(\d{2})[- ]?inch|\b(13|15|16|12|11)\b/);
        if (sizeMatch) size = sizeMatch[1] || sizeMatch[2];

        // Extract year
        let year = '';
        const yearMatch = clean.match(/\b(20\d{2})\b/);
        if (yearMatch) year = yearMatch[1];

        if (!year || !size) return null;
        return `${family}-${size}-${year}`;
    }

    // Parse specs from detail page description: "SERIAL, RAM: 16GB, SSD: 256GB, Processor: Dual-Core Intel Core i5"
    function parseSpecs(description) {
        const ramMatch = description.match(/RAM:\s*(\d+)\s*GB/i);
        const ssdMatch = description.match(/SSD:\s*(\d+)\s*(GB|TB)/i);
        const procMatch = description.match(/Processor:\s*(.+?)$/im);
        const serialMatch = description.match(/^([A-Z0-9]{10,})/);

        const ramGB = ramMatch ? parseInt(ramMatch[1], 10) : null;
        let ssdGB = null;
        if (ssdMatch) {
            ssdGB = parseInt(ssdMatch[1], 10);
            if (ssdMatch[2].toUpperCase() === 'TB') ssdGB *= 1024;
        }
        const processor = procMatch ? procMatch[1].trim() : null;
        const serial = serialMatch ? serialMatch[1] : null;

        return { ramGB, ssdGB, processor, serial };
    }

    function lookupPrice(modelKey, ramGB, ssdGB) {
        const model = PRICE_TABLE[modelKey];
        if (!model) return null;

        const key = `${ramGB}-${ssdGB}`;
        if (model[key]) return model[key];

        // Try closest match — same RAM, nearest SSD
        const sameRam = Object.keys(model).filter(k => k.startsWith(ramGB + '-'));
        if (sameRam.length > 0) {
            sameRam.sort((a, b) => {
                const ssdA = parseInt(a.split('-')[1], 10);
                const ssdB = parseInt(b.split('-')[1], 10);
                return Math.abs(ssdA - ssdGB) - Math.abs(ssdB - ssdGB);
            });
            return model[sameRam[0]];
        }

        return null;
    }

    function buildSearchQuery(titleText) {
        return titleText.replace(/#\d+\s*/, '').trim();
    }

    function buildBackMarketUrl(titleText) {
        const q = encodeURIComponent(buildSearchQuery(titleText));
        return `https://www.backmarket.co.uk/en-gb/search?q=${q}`;
    }

    function buildEbayUrl(titleText) {
        const q = encodeURIComponent(buildSearchQuery(titleText));
        return `https://www.ebay.co.uk/sch/i.html?_nkw=${q}&_sacat=111422&LH_Sold=1`;
    }

    function createLoadingBadge() {
        const badge = document.createElement('div');
        badge.className = BADGE_CLASS;
        const loading = document.createElement('span');
        loading.className = 'mp-loading';
        loading.textContent = 'Loading specs...';
        badge.appendChild(loading);
        return badge;
    }

    function updateBadge(badge, titleText, specs, modelKey) {
        badge.textContent = '';

        // Specs line
        if (specs && (specs.ramGB || specs.processor)) {
            const specsDiv = document.createElement('div');
            specsDiv.className = 'mp-specs';
            const parts = [];
            if (specs.processor) parts.push(specs.processor);
            if (specs.ramGB) parts.push(specs.ramGB + 'GB RAM');
            if (specs.ssdGB) parts.push((specs.ssdGB >= 1024 ? (specs.ssdGB / 1024) + 'TB' : specs.ssdGB + 'GB') + ' SSD');
            specsDiv.textContent = parts.join(' | ');
            badge.appendChild(specsDiv);
        }

        // Price line
        const priceDiv = document.createElement('div');
        if (specs && modelKey) {
            const price = lookupPrice(modelKey, specs.ramGB, specs.ssdGB);
            if (price) {
                priceDiv.className = 'mp-price';
                priceDiv.textContent = `Est. market value: \u00A3${price[0]} \u2013 \u00A3${price[1]}`;
            } else {
                priceDiv.className = 'mp-price-unknown';
                priceDiv.textContent = 'Price estimate unavailable for this config';
            }
        } else {
            priceDiv.className = 'mp-price-unknown';
            priceDiv.textContent = 'Could not determine specs';
        }
        badge.appendChild(priceDiv);

        // Links line
        const linksDiv = document.createElement('div');
        linksDiv.className = 'mp-links';

        const bmLink = document.createElement('a');
        bmLink.href = buildBackMarketUrl(titleText);
        bmLink.target = '_blank';
        bmLink.rel = 'noopener';
        bmLink.textContent = 'Back Market UK';
        linksDiv.appendChild(bmLink);

        const ebayLink = document.createElement('a');
        ebayLink.href = buildEbayUrl(titleText);
        ebayLink.target = '_blank';
        ebayLink.rel = 'noopener';
        ebayLink.textContent = 'eBay UK (sold)';
        linksDiv.appendChild(ebayLink);

        badge.appendChild(linksDiv);
    }

    async function fetchSpecs(detailUrl) {
        try {
            const resp = await fetch(detailUrl);
            if (!resp.ok) return null;
            const html = await resp.text();

            // Parse meta description
            const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
            if (metaMatch) return parseSpecs(metaMatch[1]);

            // Fallback: parse from description div
            const descMatch = html.match(/c-node-ai__description[\s\S]*?<p>([\s\S]*?)<\/p>/);
            if (descMatch) return parseSpecs(descMatch[1].replace(/<[^>]+>/g, '').trim());
        } catch (e) {
            console.error('MacBook Price Enricher: fetch error for', detailUrl, e);
        }
        return null;
    }

    function isMacBook(titleText) {
        return /macbook/i.test(titleText);
    }

    async function enrichItem(item) {
        const titleEl = item.querySelector('h3.c-node-ai__title a, .c-node-ai__title a');
        if (!titleEl) return;

        const titleText = titleEl.textContent.replace(/\s+/g, ' ').trim();
        if (!isMacBook(titleText)) return;

        item.classList.add(ENRICHED_CLASS);
        const modelKey = parseModelFromTitle(titleText);

        // Insert loading badge
        const badge = createLoadingBadge();
        const insertTarget = item.querySelector('.c-node-ai__details-wrap') || item.querySelector('.c-node-ai__content') || titleEl.parentElement;
        insertTarget.appendChild(badge);

        // Fetch specs from detail page
        const detailUrl = titleEl.href;
        const specs = await fetchSpecs(detailUrl);

        updateBadge(badge, titleText, specs, modelKey);
        console.log('MacBook Price Enricher:', titleText, modelKey, specs);
    }

    // Also enrich the full/detail view if we're on a MacBook detail page
    async function enrichDetailPage() {
        const fullItem = document.querySelector('.c-node-ai--full');
        if (!fullItem) return;

        const titleEl = fullItem.querySelector('h1.c-node-ai__title, .c-node-ai__title');
        if (!titleEl) return;

        const titleText = titleEl.textContent.replace(/\s+/g, ' ').trim();
        if (!isMacBook(titleText)) return;

        fullItem.classList.add(ENRICHED_CLASS);
        const modelKey = parseModelFromTitle(titleText);

        // On detail page, specs are available directly
        const descEl = fullItem.querySelector('.c-node-ai__description p, .c-node-ai__description');
        const metaDesc = document.querySelector('meta[name="description"]');
        const descText = (descEl ? descEl.textContent : '') || (metaDesc ? metaDesc.content : '');
        const specs = parseSpecs(descText);

        const badge = document.createElement('div');
        badge.className = BADGE_CLASS;

        const aboutSection = fullItem.querySelector('.c-node-ai__about') || titleEl.parentElement;
        aboutSection.appendChild(badge);

        updateBadge(badge, titleText, specs, modelKey);
    }

    async function enrichAll() {
        ensureStyles();

        // Enrich detail page if applicable
        enrichDetailPage();

        // Enrich list/teaser items
        const items = document.querySelectorAll('.c-node-ai--small-teaser:not(.' + ENRICHED_CLASS + '), .c-node-ai--teaser-view:not(.' + ENRICHED_CLASS + ')');
        const macbooks = [];
        items.forEach(item => {
            const titleEl = item.querySelector('h3.c-node-ai__title a, .c-node-ai__title a');
            if (titleEl && isMacBook(titleEl.textContent)) {
                macbooks.push(item);
            }
        });

        if (macbooks.length === 0) return;
        console.log('MacBook Price Enricher: Found ' + macbooks.length + ' MacBook items to enrich.');

        // Process sequentially to avoid hammering the server
        for (const item of macbooks) {
            await enrichItem(item);
        }
    }

    // Run after page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(enrichAll, 1000));
    } else {
        setTimeout(enrichAll, 1000);
    }

    // Watch for dynamic content (AJAX navigation)
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(enrichAll, 1500);
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
