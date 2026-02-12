// ==UserScript==
// @name         ServiceNow KB Graph View
// @namespace    https://www.linkedin.com/in/joanmarcriera/
// @version      1.1
// @description  Obsidian-like graph visualization of linked ServiceNow Knowledge Base articles
// @author       Joan Marc Riera (https://www.linkedin.com/in/joanmarcriera/)
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @require      https://d3js.org/d3.v7.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ─── Constants ───────────────────────────────────────────────
    const MAX_NODES = 100;
    const MIN_PANEL_W = 400;
    const MIN_PANEL_H = 300;
    const COLORS = {
        central: '#7c3aed',
        regular: '#64748b',
        expanded: '#3b82f6',
        hover: '#a78bfa',
        link: '#334155',
        linkHover: '#475569',
        bgPrimary: '#1e1e1e',
        bgSecondary: '#0f172a',
        border: '#334155',
        textPrimary: '#e2e8f0',
        textSecondary: '#94a3b8',
        duplicate: '#f59e0b',
    };
    const NODE_RADIUS = { central: 16, depth1: 10, depth2: 8, deep: 6 };

    // ─── Helpers ─────────────────────────────────────────────────

    function buildKbUrl(kbNumber) {
        return `${window.location.origin}/kb_view.do?sysparm_article=${kbNumber}`;
    }

    function formatNodeLabel(id, title) {
        const t = (!title || title === id) ? '' : title;
        if (!t) return id;
        const maxTitle = 30;
        const truncated = t.length > maxTitle ? t.substring(0, maxTitle) + '...' : t;
        return `${id} - ${truncated}`;
    }

    function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    // ─── Data Extraction ─────────────────────────────────────────

    function getKbNumber() {
        const el = document.getElementById('articleNumberReadonly');
        if (el && el.textContent.trim()) {
            return el.textContent.trim().split(/\s+/)[0];
        }
        return null;
    }

    function getArticleTitle() {
        const el = document.getElementById('articleTitleReadonly');
        if (el && el.textContent.trim()) {
            return el.textContent.trim();
        }
        return document.title || 'KB Article';
    }

    function getArticleOriginalHtml() {
        const el = document.getElementById('articleOriginal');
        if (!el || !el.value) return '';
        return el.value;
    }

    function extractKbLinks(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const anchors = Array.from(doc.querySelectorAll('a[href]'));
        const links = [];
        const seen = new Set();

        for (const a of anchors) {
            const href = a.getAttribute('href');
            if (!href) continue;

            let url;
            try {
                url = new URL(href, window.location.origin);
            } catch (e) {
                continue;
            }

            const hrefStr = url.href;
            if (hrefStr.includes('kb_view.do') || hrefStr.includes('kb_article')) {
                const kb = url.searchParams.get('sysparm_article');
                if (kb && kb.startsWith('KB') && !seen.has(kb)) {
                    seen.add(kb);
                    const label = (a.textContent || '').trim() || kb;
                    links.push({ kb, label });
                }
            }
        }
        return links;
    }

    // ─── API ─────────────────────────────────────────────────────

    function getAuthToken() {
        return window.g_ck || '';
    }

    async function fetchKbArticle(kbNumber) {
        const base = window.location.origin;
        const url = `${base}/api/now/table/kb_knowledge?sysparm_query=number=${encodeURIComponent(kbNumber)}&sysparm_fields=sys_id,number,short_description,text&sysparm_limit=1`;

        const resp = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'X-UserToken': getAuthToken(),
            },
        });

        if (!resp.ok) {
            const err = new Error(`API error ${resp.status}`);
            err.status = resp.status;
            throw err;
        }

        const data = await resp.json();
        if (!data.result || data.result.length === 0) {
            const err = new Error(`Article ${kbNumber} not found`);
            err.status = 404;
            throw err;
        }

        const article = data.result[0];
        return {
            number: article.number,
            title: article.short_description || kbNumber,
            html: article.text || '',
        };
    }

    async function fetchWithRetry(kbNumber, maxRetries = 2) {
        let lastErr;
        for (let i = 0; i <= maxRetries; i++) {
            try {
                return await fetchKbArticle(kbNumber);
            } catch (e) {
                lastErr = e;
                if (e.status === 401 || e.status === 403 || e.status === 404) throw e;
                if (i < maxRetries) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
                }
            }
        }
        throw lastErr;
    }

    // ─── Graph Data Model ────────────────────────────────────────

    class GraphModel {
        constructor() {
            this.nodes = new Map();
            this.links = new Set();
            this.fetchCache = new Map();
        }

        addNode(id, label, depth = 0) {
            if (this.nodes.has(id)) return this.nodes.get(id);
            const node = { id, label, depth, expanded: false, titleFetched: false };
            this.nodes.set(id, node);
            return node;
        }

        addLink(source, target) {
            const key = [source, target].sort().join('|');
            if (this.links.has(key)) return;
            this.links.add(key);
        }

        async expandNode(kbNumber) {
            const node = this.nodes.get(kbNumber);
            if (!node || node.expanded) return { newNodes: [], newLinks: [] };
            if (this.nodes.size >= MAX_NODES) {
                throw new Error(`Graph limit reached (${MAX_NODES} nodes). Cannot expand further.`);
            }

            node.expanded = true;
            const newNodes = [];
            const newLinks = [];

            let articleData;
            if (this.fetchCache.has(kbNumber)) {
                articleData = await this.fetchCache.get(kbNumber);
            } else {
                const promise = fetchWithRetry(kbNumber);
                this.fetchCache.set(kbNumber, promise);
                articleData = await promise;
            }

            if (articleData.title && articleData.title !== kbNumber) {
                node.label = articleData.title;
                node.titleFetched = true;
            }

            const kbLinks = extractKbLinks(articleData.html);

            for (const link of kbLinks) {
                if (link.kb === kbNumber) continue;
                if (this.nodes.size >= MAX_NODES) break;

                if (!this.nodes.has(link.kb)) {
                    const newNode = this.addNode(link.kb, link.label, node.depth + 1);
                    newNodes.push(newNode);
                }
                const linkKey = [kbNumber, link.kb].sort().join('|');
                if (!this.links.has(linkKey)) {
                    this.addLink(kbNumber, link.kb);
                    newLinks.push({ source: kbNumber, target: link.kb });
                }
            }

            return { newNodes, newLinks };
        }

        /** Batch-fetch titles for nodes that haven't been expanded yet */
        async fetchTitlesForUnexpanded() {
            const toFetch = [];
            for (const [id, node] of this.nodes) {
                if (!node.titleFetched && !node.expanded) {
                    toFetch.push(id);
                }
            }
            if (toFetch.length === 0) return [];

            const updated = [];
            const promises = toFetch.map(async (kbNumber) => {
                try {
                    let articleData;
                    if (this.fetchCache.has(kbNumber)) {
                        articleData = await this.fetchCache.get(kbNumber);
                    } else {
                        const promise = fetchWithRetry(kbNumber);
                        this.fetchCache.set(kbNumber, promise);
                        articleData = await promise;
                    }
                    const node = this.nodes.get(kbNumber);
                    if (node && articleData.title && articleData.title !== kbNumber) {
                        node.label = articleData.title;
                        node.titleFetched = true;
                        updated.push(kbNumber);
                    }
                } catch (e) {
                    console.warn(`KB Graph: could not fetch title for ${kbNumber}`, e.message);
                }
            });

            await Promise.allSettled(promises);
            return updated;
        }

        /** Get neighbors of a node */
        getNeighbors(nodeId) {
            const neighbors = [];
            for (const key of this.links) {
                const [a, b] = key.split('|');
                if (a === nodeId) neighbors.push(b);
                else if (b === nodeId) neighbors.push(a);
            }
            return neighbors;
        }

        getNodesArray() {
            return Array.from(this.nodes.values());
        }

        getLinksArray() {
            return Array.from(this.links).map(key => {
                const [source, target] = key.split('|');
                return { source, target };
            });
        }
    }

    // ─── D3 Graph Renderer ───────────────────────────────────────

    class GraphRenderer {
        constructor(container, centralId) {
            this.container = container;
            this.centralId = centralId;
            this.simulation = null;
            this.svg = null;
            this.linkGroup = null;
            this.nodeGroup = null;
            this.labelGroup = null;
            this.zoom = null;
            this.width = 0;
            this.height = 0;
        }

        initialize() {
            const rect = this.container.getBoundingClientRect();
            this.width = rect.width;
            this.height = rect.height;

            this.svg = d3.select(this.container)
                .append('svg')
                .attr('width', '100%')
                .attr('height', '100%')
                .style('background', COLORS.bgPrimary);

            const g = this.svg.append('g').attr('class', 'graph-root');
            this.linkGroup = g.append('g').attr('class', 'links');
            this.nodeGroup = g.append('g').attr('class', 'nodes');
            this.labelGroup = g.append('g').attr('class', 'labels');

            this.zoom = d3.zoom()
                .scaleExtent([0.1, 4])
                .on('zoom', (event) => {
                    g.attr('transform', event.transform);
                });
            this.svg.call(this.zoom);

            this.simulation = d3.forceSimulation()
                .force('link', d3.forceLink().id(d => d.id).distance(150).strength(0.5))
                .force('charge', d3.forceManyBody().strength(-300))
                .force('center', d3.forceCenter(this.width / 2, this.height / 2))
                .force('collide', d3.forceCollide(40).strength(0.7))
                .alphaDecay(0.02)
                .velocityDecay(0.3)
                .on('tick', () => this._tick());
        }

        render(nodes, links, onExpand, onSelect, onOpen) {
            this.onExpand = onExpand;
            this.onSelect = onSelect;
            this.onOpen = onOpen;
            this._update(nodes, links);
            this.simulation.nodes(nodes);
            this.simulation.force('link').links(links);
            this.simulation.alpha(1).restart();
        }

        addIncremental(allNodes, allLinks) {
            this._update(allNodes, allLinks);
            this.simulation.nodes(allNodes);
            this.simulation.force('link').links(allLinks);
            this.simulation.alpha(0.3).restart();
        }

        updateLabels() {
            this.labelGroup.selectAll('text')
                .text(d => formatNodeLabel(d.id, d.label));
        }

        resize(w, h) {
            this.width = w;
            this.height = h;
            if (this.simulation) {
                this.simulation.force('center', d3.forceCenter(w / 2, h / 2));
                this.simulation.alpha(0.1).restart();
            }
        }

        show() {
            if (this.svg) this.svg.style('display', null);
            if (this.simulation) this.simulation.alpha(0.05).restart();
        }

        hide() {
            if (this.svg) this.svg.style('display', 'none');
            if (this.simulation) this.simulation.stop();
        }

        fitToView() {
            const g = this.svg.select('.graph-root');
            const bounds = g.node().getBBox();
            if (bounds.width === 0 || bounds.height === 0) return;

            const rect = this.container.getBoundingClientRect();
            this.width = rect.width;
            this.height = rect.height;

            const scale = 0.85 / Math.max(bounds.width / this.width, bounds.height / this.height);
            const tx = this.width / 2 - scale * (bounds.x + bounds.width / 2);
            const ty = this.height / 2 - scale * (bounds.y + bounds.height / 2);

            this.svg.transition().duration(750)
                .call(this.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
        }

        resetZoom() {
            this.svg.transition().duration(750)
                .call(this.zoom.transform, d3.zoomIdentity);
        }

        _nodeRadius(d) {
            if (d.id === this.centralId) return NODE_RADIUS.central;
            if (d.depth <= 1) return NODE_RADIUS.depth1;
            if (d.depth === 2) return NODE_RADIUS.depth2;
            return NODE_RADIUS.deep;
        }

        _nodeColor(d) {
            if (d.id === this.centralId) return COLORS.central;
            if (d.expanded) return COLORS.expanded;
            return COLORS.regular;
        }

        _update(nodes, links) {
            const self = this;

            // Links
            const linkKey = d => {
                const s = typeof d.source === 'object' ? d.source.id : d.source;
                const t = typeof d.target === 'object' ? d.target.id : d.target;
                return s + '|' + t;
            };
            const linkSel = this.linkGroup.selectAll('line').data(links, linkKey);
            linkSel.exit().remove();
            linkSel.enter().append('line')
                .attr('stroke', COLORS.link)
                .attr('stroke-width', 1.5)
                .attr('stroke-opacity', 0.6);

            // Nodes
            const nodeSel = this.nodeGroup.selectAll('circle').data(nodes, d => d.id);
            nodeSel.exit().remove();
            const nodeEnter = nodeSel.enter().append('circle')
                .attr('r', d => self._nodeRadius(d))
                .attr('fill', d => self._nodeColor(d))
                .attr('stroke', COLORS.bgSecondary)
                .attr('stroke-width', 2)
                .style('cursor', 'pointer')
                .on('mouseover', function (event, d) {
                    d3.select(this).attr('fill', COLORS.hover);
                    self._highlightLinks(d.id, true);
                })
                .on('mouseout', function (event, d) {
                    d3.select(this).attr('fill', self._nodeColor(d));
                    self._highlightLinks(d.id, false);
                })
                .on('click', function (event, d) {
                    if (self.onSelect) self.onSelect(d);
                })
                .on('dblclick', function (event, d) {
                    event.stopPropagation();
                    if (self.onExpand) self.onExpand(d);
                })
                .on('contextmenu', function (event, d) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (self.onOpen) self.onOpen(d);
                })
                .call(d3.drag()
                    .on('start', (event, d) => {
                        if (!event.active) self.simulation.alphaTarget(0.3).restart();
                        d.fx = d.x;
                        d.fy = d.y;
                    })
                    .on('drag', (event, d) => {
                        d.fx = event.x;
                        d.fy = event.y;
                    })
                    .on('end', (event, d) => {
                        if (!event.active) self.simulation.alphaTarget(0);
                        d.fx = null;
                        d.fy = null;
                    }));

            nodeEnter.attr('r', 0)
                .transition().duration(300)
                .attr('r', d => self._nodeRadius(d));

            nodeSel.attr('fill', d => self._nodeColor(d));

            // Labels
            const labelSel = this.labelGroup.selectAll('text').data(nodes, d => d.id);
            labelSel.exit().remove();
            labelSel.enter().append('text')
                .attr('text-anchor', 'middle')
                .attr('dy', d => self._nodeRadius(d) + 14)
                .attr('font-size', d => d.id === self.centralId ? '12px' : '10px')
                .attr('fill', COLORS.textPrimary)
                .attr('pointer-events', 'none')
                .text(d => formatNodeLabel(d.id, d.label));

            labelSel.text(d => formatNodeLabel(d.id, d.label));
        }

        _highlightLinks(nodeId, highlight) {
            this.linkGroup.selectAll('line')
                .attr('stroke', d => {
                    const sid = typeof d.source === 'object' ? d.source.id : d.source;
                    const tid = typeof d.target === 'object' ? d.target.id : d.target;
                    if (highlight && (sid === nodeId || tid === nodeId)) return COLORS.linkHover;
                    return COLORS.link;
                })
                .attr('stroke-opacity', d => {
                    const sid = typeof d.source === 'object' ? d.source.id : d.source;
                    const tid = typeof d.target === 'object' ? d.target.id : d.target;
                    if (highlight && (sid === nodeId || tid === nodeId)) return 1;
                    return 0.6;
                })
                .attr('stroke-width', d => {
                    const sid = typeof d.source === 'object' ? d.source.id : d.source;
                    const tid = typeof d.target === 'object' ? d.target.id : d.target;
                    if (highlight && (sid === nodeId || tid === nodeId)) return 2.5;
                    return 1.5;
                });
        }

        _tick() {
            this.linkGroup.selectAll('line')
                .attr('x1', d => d.source.x)
                .attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x)
                .attr('y2', d => d.target.y);

            this.nodeGroup.selectAll('circle')
                .attr('cx', d => d.x)
                .attr('cy', d => d.y);

            this.labelGroup.selectAll('text')
                .attr('x', d => d.x)
                .attr('y', d => d.y);
        }
    }

    // ─── Tree Renderer ───────────────────────────────────────────

    class TreeRenderer {
        constructor(container) {
            this.container = container;
            this.treeDiv = null;
            this.collapsedNodes = new Set();
            this.centralId = null;
            this.onExpand = null;
            this.onOpen = null;
        }

        initialize() {
            this.treeDiv = document.createElement('div');
            this.treeDiv.id = 'kb-graph-tree';
            Object.assign(this.treeDiv.style, {
                display: 'none',
                width: '100%',
                height: '100%',
                overflowY: 'auto',
                overflowX: 'auto',
                background: COLORS.bgPrimary,
                padding: '12px',
                boxSizing: 'border-box',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontSize: '13px',
                color: COLORS.textPrimary,
            });
            this.container.appendChild(this.treeDiv);
        }

        show() { if (this.treeDiv) this.treeDiv.style.display = 'block'; }
        hide() { if (this.treeDiv) this.treeDiv.style.display = 'none'; }

        setCentralId(id) { this.centralId = id; }

        render(graphModel, centralId) {
            if (!this.treeDiv) return;
            if (centralId) this.centralId = centralId;
            clearChildren(this.treeDiv);

            const visited = new Map();
            this._renderNode(graphModel, this.centralId, 0, visited, [], this.treeDiv);
        }

        _renderNode(model, nodeId, depth, visited, parentPath, parentEl) {
            const node = model.nodes.get(nodeId);
            if (!node) return;

            const row = document.createElement('div');
            Object.assign(row.style, {
                paddingLeft: (depth * 24 + 4) + 'px',
                paddingTop: '4px',
                paddingBottom: '4px',
                paddingRight: '4px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                borderRadius: '4px',
                cursor: 'default',
            });
            row.onmouseover = () => { row.style.background = 'rgba(255,255,255,0.05)'; };
            row.onmouseout = () => { row.style.background = 'transparent'; };

            const isDuplicate = visited.has(nodeId);
            const prevParents = visited.get(nodeId) || [];
            if (!isDuplicate) {
                visited.set(nodeId, [...parentPath]);
            }

            const neighbors = model.getNeighbors(nodeId);
            const childNodes = neighbors.filter(n => !parentPath.includes(n) && n !== nodeId);
            const hasChildren = node.expanded && childNodes.length > 0;
            const isCollapsed = this.collapsedNodes.has(nodeId);
            const self = this;

            // Toggle arrow
            const toggle = document.createElement('span');
            Object.assign(toggle.style, {
                width: '16px',
                display: 'inline-block',
                textAlign: 'center',
                cursor: 'pointer',
                userSelect: 'none',
                fontSize: '10px',
                color: COLORS.textSecondary,
            });

            if (isDuplicate) {
                toggle.textContent = '\u21a9';
                toggle.title = 'Duplicate \u2014 already shown above';
            } else if (hasChildren) {
                toggle.textContent = isCollapsed ? '\u25b6' : '\u25bc';
                toggle.onclick = function (e) {
                    e.stopPropagation();
                    if (isCollapsed) {
                        self.collapsedNodes.delete(nodeId);
                    } else {
                        self.collapsedNodes.add(nodeId);
                    }
                    self.render(model, self.centralId);
                };
            } else if (!node.expanded && !isDuplicate) {
                toggle.textContent = '\u25b6';
                toggle.style.opacity = '0.5';
                toggle.title = 'Double-click to load links';
                toggle.ondblclick = function (e) {
                    e.stopPropagation();
                    if (self.onExpand) self.onExpand(node);
                };
            } else {
                toggle.textContent = '\u00b7';
            }
            row.appendChild(toggle);

            // Color dot
            const dot = document.createElement('span');
            Object.assign(dot.style, {
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                display: 'inline-block',
                flexShrink: '0',
            });
            if (isDuplicate) {
                dot.style.background = COLORS.duplicate;
            } else if (depth === 0) {
                dot.style.background = COLORS.central;
            } else if (node.expanded) {
                dot.style.background = COLORS.expanded;
            } else {
                dot.style.background = COLORS.regular;
            }
            row.appendChild(dot);

            // Label text
            const label = document.createElement('span');
            Object.assign(label.style, {
                flex: '1',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            });
            label.textContent = node.id + ' - ' + (node.label !== node.id ? node.label : '...');
            if (isDuplicate) {
                label.style.fontStyle = 'italic';
                label.style.opacity = '0.7';
            }
            row.appendChild(label);

            // Duplicate badge
            if (isDuplicate && prevParents.length > 0) {
                const badge = document.createElement('span');
                Object.assign(badge.style, {
                    fontSize: '10px',
                    background: COLORS.duplicate,
                    color: '#000',
                    padding: '1px 6px',
                    borderRadius: '8px',
                    whiteSpace: 'nowrap',
                    flexShrink: '0',
                });
                const fromKb = prevParents[prevParents.length - 1] || '?';
                badge.textContent = 'also from ' + fromKb;
                row.appendChild(badge);
            }

            // Open link icon
            const openLink = document.createElement('a');
            openLink.href = buildKbUrl(nodeId);
            openLink.target = '_blank';
            openLink.rel = 'noopener';
            openLink.textContent = '\u2197';
            Object.assign(openLink.style, {
                color: COLORS.textSecondary,
                textDecoration: 'none',
                fontSize: '14px',
                flexShrink: '0',
                padding: '0 2px',
            });
            openLink.onmouseover = function () { openLink.style.color = COLORS.textPrimary; };
            openLink.onmouseout = function () { openLink.style.color = COLORS.textSecondary; };
            openLink.title = 'Open ' + nodeId + ' in new tab';
            row.appendChild(openLink);

            parentEl.appendChild(row);

            // Don't recurse for duplicates
            if (isDuplicate) return;

            // Recurse children
            if (hasChildren && !isCollapsed) {
                const currentPath = [...parentPath, nodeId];
                for (const childId of childNodes) {
                    this._renderNode(model, childId, depth + 1, visited, currentPath, parentEl);
                }
            }
        }
    }

    // ─── Floating Panel UI ───────────────────────────────────────

    function createPanel() {
        const overlay = document.createElement('div');
        overlay.id = 'kb-graph-overlay';
        Object.assign(overlay.style, {
            display: 'none',
            position: 'fixed',
            top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0,0,0,0.5)',
            zIndex: '10000',
        });

        const panel = document.createElement('div');
        panel.id = 'kb-graph-panel';
        Object.assign(panel.style, {
            position: 'absolute',
            top: '10vh', left: '10vw',
            width: '80vw', height: '80vh',
            background: COLORS.bgPrimary,
            border: '1px solid ' + COLORS.border,
            borderRadius: '8px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            overflow: 'hidden',
        });

        // Title bar
        const titleBar = document.createElement('div');
        Object.assign(titleBar.style, {
            background: COLORS.bgSecondary,
            color: COLORS.textPrimary,
            padding: '10px 16px',
            borderBottom: '1px solid ' + COLORS.border,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'move',
            userSelect: 'none',
            flexShrink: '0',
        });

        const titleText = document.createElement('span');
        titleText.id = 'kb-graph-title';
        titleText.textContent = 'KB Graph View';
        titleText.style.fontSize = '14px';
        titleText.style.fontWeight = '600';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u00d7';
        Object.assign(closeBtn.style, {
            background: 'transparent',
            border: 'none',
            color: COLORS.textSecondary,
            fontSize: '22px',
            cursor: 'pointer',
            padding: '0',
            lineHeight: '1',
        });
        closeBtn.onmouseover = function () { closeBtn.style.color = COLORS.textPrimary; };
        closeBtn.onmouseout = function () { closeBtn.style.color = COLORS.textSecondary; };
        closeBtn.onclick = function () { hidePanel(); };

        const authorLink = document.createElement('a');
        authorLink.href = 'https://www.linkedin.com/in/joanmarcriera/';
        authorLink.target = '_blank';
        authorLink.rel = 'noopener';
        authorLink.textContent = 'by Joan Marc Riera';
        Object.assign(authorLink.style, {
            color: COLORS.textSecondary,
            fontSize: '11px',
            textDecoration: 'none',
            marginLeft: '10px',
        });
        authorLink.onmouseover = function () { authorLink.style.color = COLORS.hover; };
        authorLink.onmouseout = function () { authorLink.style.color = COLORS.textSecondary; };

        const titleLeft = document.createElement('div');
        titleLeft.style.display = 'flex';
        titleLeft.style.alignItems = 'baseline';
        titleLeft.style.gap = '4px';
        titleLeft.appendChild(titleText);
        titleLeft.appendChild(authorLink);

        titleBar.appendChild(titleLeft);
        titleBar.appendChild(closeBtn);

        // Graph container
        const graphContainer = document.createElement('div');
        graphContainer.id = 'kb-graph-container';
        Object.assign(graphContainer.style, {
            flex: '1',
            position: 'relative',
            overflow: 'hidden',
        });

        // Loading overlay
        const loading = document.createElement('div');
        loading.id = 'kb-graph-loading';
        Object.assign(loading.style, {
            display: 'none',
            position: 'absolute',
            top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0,0,0,0.7)',
            zIndex: '10',
            alignItems: 'center',
            justifyContent: 'center',
        });
        const spinner = document.createElement('div');
        Object.assign(spinner.style, {
            width: '40px', height: '40px',
            border: '3px solid ' + COLORS.border,
            borderTop: '3px solid ' + COLORS.central,
            borderRadius: '50%',
            animation: 'kb-graph-spin 1s linear infinite',
        });
        loading.appendChild(spinner);
        graphContainer.appendChild(loading);

        // Footer
        const footer = document.createElement('div');
        footer.id = 'kb-graph-footer';
        Object.assign(footer.style, {
            background: COLORS.bgSecondary,
            borderTop: '1px solid ' + COLORS.border,
            padding: '8px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: '0',
            fontSize: '12px',
            color: COLORS.textSecondary,
            gap: '8px',
        });

        // Footer left: info area
        const infoArea = document.createElement('div');
        infoArea.id = 'kb-graph-info';
        Object.assign(infoArea.style, {
            flex: '1',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
        });
        infoArea.textContent = 'Double-click a node to expand \u2022 Right-click to open';

        // Footer right: controls
        const controlsRight = document.createElement('div');
        controlsRight.style.display = 'flex';
        controlsRight.style.gap = '6px';
        controlsRight.style.flexShrink = '0';

        const makeBtnStyle = function (btn) {
            Object.assign(btn.style, {
                background: COLORS.bgPrimary,
                border: '1px solid ' + COLORS.border,
                color: COLORS.textPrimary,
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '11px',
                cursor: 'pointer',
            });
            btn.onmouseover = function () { btn.style.background = COLORS.border; };
            btn.onmouseout = function () { btn.style.background = COLORS.bgPrimary; };
        };

        const viewToggleBtn = document.createElement('button');
        viewToggleBtn.id = 'kb-graph-view-toggle';
        viewToggleBtn.textContent = 'Tree View';
        makeBtnStyle(viewToggleBtn);

        const fitBtn = document.createElement('button');
        fitBtn.textContent = 'Fit to View';
        fitBtn.id = 'kb-graph-fit-btn';
        makeBtnStyle(fitBtn);

        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset Zoom';
        resetBtn.id = 'kb-graph-reset-btn';
        makeBtnStyle(resetBtn);

        const expandAllBtn = document.createElement('button');
        expandAllBtn.id = 'kb-graph-expand-all';
        expandAllBtn.textContent = '+ Expand All';
        expandAllBtn.title = 'Fetch & expand all unexpanded nodes (next level)';
        makeBtnStyle(expandAllBtn);

        const collapseAllBtn = document.createElement('button');
        collapseAllBtn.id = 'kb-graph-collapse-all';
        collapseAllBtn.textContent = '\u2212 Collapse All';
        collapseAllBtn.title = 'Collapse all nodes in tree view';
        makeBtnStyle(collapseAllBtn);
        collapseAllBtn.style.display = 'none';

        controlsRight.appendChild(viewToggleBtn);
        controlsRight.appendChild(expandAllBtn);
        controlsRight.appendChild(collapseAllBtn);
        controlsRight.appendChild(fitBtn);
        controlsRight.appendChild(resetBtn);
        footer.appendChild(infoArea);
        footer.appendChild(controlsRight);

        panel.appendChild(titleBar);
        panel.appendChild(graphContainer);
        panel.appendChild(footer);

        // Resize handle (bottom-right corner)
        const resizeHandle = document.createElement('div');
        Object.assign(resizeHandle.style, {
            position: 'absolute',
            bottom: '0', right: '0',
            width: '16px', height: '16px',
            cursor: 'nwse-resize',
            zIndex: '20',
        });
        const grip = document.createElement('div');
        Object.assign(grip.style, {
            position: 'absolute',
            bottom: '3px', right: '3px',
            width: '10px', height: '10px',
            borderRight: '2px solid ' + COLORS.textSecondary,
            borderBottom: '2px solid ' + COLORS.textSecondary,
            opacity: '0.5',
        });
        resizeHandle.appendChild(grip);
        panel.appendChild(resizeHandle);

        overlay.appendChild(panel);

        // Inject keyframe animation
        const style = document.createElement('style');
        style.textContent = [
            '@keyframes kb-graph-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }',
            '#kb-graph-info a { color: ' + COLORS.hover + '; text-decoration: none; }',
            '#kb-graph-info a:hover { text-decoration: underline; color: ' + COLORS.textPrimary + '; }',
        ].join('\n');
        document.head.appendChild(style);

        // Draggable title bar
        let isDragging = false, dragOffX = 0, dragOffY = 0;
        titleBar.addEventListener('mousedown', function (e) {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffX = e.clientX - rect.left;
            dragOffY = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!isDragging) return;
            panel.style.left = (e.clientX - dragOffX) + 'px';
            panel.style.top = (e.clientY - dragOffY) + 'px';
        });
        document.addEventListener('mouseup', function () { isDragging = false; });

        // Resizable via corner handle
        let isResizing = false, resizeStartX = 0, resizeStartY = 0, startW = 0, startH = 0;
        resizeHandle.addEventListener('mousedown', function (e) {
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;
            e.preventDefault();
            e.stopPropagation();
        });
        document.addEventListener('mousemove', function (e) {
            if (!isResizing) return;
            const newW = Math.max(MIN_PANEL_W, startW + (e.clientX - resizeStartX));
            const newH = Math.max(MIN_PANEL_H, startH + (e.clientY - resizeStartY));
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
        });
        document.addEventListener('mouseup', function () {
            if (isResizing) {
                isResizing = false;
                if (renderer) {
                    const rect = graphContainer.getBoundingClientRect();
                    renderer.resize(rect.width, rect.height);
                }
            }
        });

        // Close on overlay background click
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) hidePanel();
        });

        document.body.appendChild(overlay);
        return {
            overlay, panel, graphContainer, loading, titleText, infoArea,
            fitBtn, resetBtn, viewToggleBtn, expandAllBtn, collapseAllBtn,
        };
    }

    // ─── State ───────────────────────────────────────────────────

    let panelElements = null;
    let graphModel = null;
    let renderer = null;
    let treeRenderer = null;
    let initialized = false;
    let currentView = 'graph';
    let selectedNode = null;

    function showPanel() {
        if (!panelElements) panelElements = createPanel();
        panelElements.overlay.style.display = 'block';
    }

    function hidePanel() {
        if (panelElements) panelElements.overlay.style.display = 'none';
    }

    function setLoading(on) {
        if (!panelElements) return;
        panelElements.loading.style.display = on ? 'flex' : 'none';
    }

    function updateInfo(text, linkNode) {
        if (!panelElements) return;
        const area = panelElements.infoArea;
        clearChildren(area);

        if (linkNode) {
            const a = document.createElement('a');
            a.href = buildKbUrl(linkNode.id);
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = linkNode.id + ' - ' + linkNode.label;
            a.title = 'Click to open in new tab';
            area.appendChild(a);

            if (linkNode.expanded) {
                area.appendChild(document.createTextNode(' (expanded)'));
            }
        } else {
            area.textContent = text;
        }
    }

    function updateNodeCount() {
        if (!graphModel || selectedNode) return;
        const count = graphModel.nodes.size;
        const linkCount = graphModel.links.size;
        updateInfo(count + ' nodes, ' + linkCount + ' links \u2022 Dbl-click expand \u2022 Right-click open');
    }

    // ─── View Toggle ─────────────────────────────────────────────

    function switchView(view) {
        currentView = view;
        if (!panelElements) return;

        const btn = panelElements.viewToggleBtn;
        const fitBtn = panelElements.fitBtn;
        const resetBtn = panelElements.resetBtn;

        if (view === 'tree') {
            btn.textContent = 'Graph View';
            renderer.hide();
            treeRenderer.show();
            treeRenderer.render(graphModel, graphModel.getNodesArray()[0]?.id);
            fitBtn.style.display = 'none';
            resetBtn.style.display = 'none';
            panelElements.expandAllBtn.style.display = '';
            panelElements.collapseAllBtn.style.display = '';
        } else {
            btn.textContent = 'Tree View';
            treeRenderer.hide();
            renderer.show();
            fitBtn.style.display = '';
            resetBtn.style.display = '';
            panelElements.expandAllBtn.style.display = '';
            panelElements.collapseAllBtn.style.display = 'none';
        }
    }

    // ─── Orchestration ───────────────────────────────────────────

    async function initializeGraph() {
        const kbNumber = getKbNumber();
        const title = getArticleTitle();

        if (!kbNumber) {
            updateInfo('Could not detect KB article number');
            return;
        }

        panelElements.titleText.textContent = 'KB Graph View \u2014 ' + kbNumber;

        graphModel = new GraphModel();
        graphModel.addNode(kbNumber, title, 0);
        graphModel.nodes.get(kbNumber).titleFetched = true;

        // Extract links from current page
        const rawHtml = getArticleOriginalHtml();
        if (rawHtml) {
            const kbLinks = extractKbLinks(rawHtml);
            for (const link of kbLinks) {
                if (link.kb === kbNumber) continue;
                graphModel.addNode(link.kb, link.label, 1);
                graphModel.addLink(kbNumber, link.kb);
            }
            graphModel.nodes.get(kbNumber).expanded = true;
        }

        // Initialize renderers
        renderer = new GraphRenderer(panelElements.graphContainer, kbNumber);
        renderer.initialize();

        treeRenderer = new TreeRenderer(panelElements.graphContainer);
        treeRenderer.initialize();
        treeRenderer.setCentralId(kbNumber);
        treeRenderer.onExpand = handleExpand;
        treeRenderer.onOpen = handleOpen;

        // Wire up controls
        panelElements.fitBtn.onclick = function () { renderer.fitToView(); };
        panelElements.resetBtn.onclick = function () { renderer.resetZoom(); };
        panelElements.expandAllBtn.onclick = function () { handleExpandNextLevel(); };
        panelElements.collapseAllBtn.onclick = function () { handleCollapseAll(); };
        panelElements.viewToggleBtn.onclick = function () {
            switchView(currentView === 'graph' ? 'tree' : 'graph');
        };

        // Render graph
        renderer.render(
            graphModel.getNodesArray(),
            graphModel.getLinksArray(),
            handleExpand,
            handleSelect,
            handleOpen
        );

        updateNodeCount();
        initialized = true;

        // Auto fit after simulation settles
        setTimeout(function () { renderer.fitToView(); }, 1500);

        // Batch-fetch titles for depth-1 nodes in background
        graphModel.fetchTitlesForUnexpanded().then(function (updated) {
            if (updated.length > 0) {
                renderer.updateLabels();
                if (currentView === 'tree') {
                    treeRenderer.render(graphModel, kbNumber);
                }
            }
        });
    }

    async function handleExpand(node) {
        if (node.expanded) {
            updateInfo(node.id + ' is already expanded');
            return;
        }

        setLoading(true);
        updateInfo('Loading ' + node.id + '...');

        try {
            const result = await graphModel.expandNode(node.id);

            if (result.newNodes.length === 0 && result.newLinks.length === 0) {
                updateInfo(node.id + ' has no linked KB articles');
            } else {
                renderer.addIncremental(
                    graphModel.getNodesArray(),
                    graphModel.getLinksArray()
                );
                selectedNode = null;
                updateNodeCount();

                // Fetch titles for new nodes in background
                graphModel.fetchTitlesForUnexpanded().then(function (updated) {
                    if (updated.length > 0) {
                        renderer.updateLabels();
                        if (currentView === 'tree') {
                            const centralId = graphModel.getNodesArray()[0]?.id;
                            treeRenderer.render(graphModel, centralId);
                        }
                    }
                });
            }

            // Refresh tree if active
            if (currentView === 'tree') {
                const centralId = graphModel.getNodesArray()[0]?.id;
                treeRenderer.render(graphModel, centralId);
            }
        } catch (e) {
            if (e.status === 401 || e.status === 403) {
                updateInfo('Session expired or access denied. Refresh the page.');
            } else if (e.status === 404) {
                updateInfo(node.id + ' not found or not accessible');
                node.expanded = true;
            } else {
                updateInfo('Error loading ' + node.id + ': ' + e.message);
            }
            console.error('KB Graph expand error:', e);
        } finally {
            setLoading(false);
        }
    }

    function handleSelect(node) {
        selectedNode = node;
        updateInfo(null, node);
    }

    function handleOpen(node) {
        window.open(buildKbUrl(node.id), '_blank');
    }

    /** Expand next level: fetch all currently-unexpanded visible nodes */
    async function handleExpandNextLevel() {
        if (!graphModel) return;

        const toExpand = [];
        for (const [id, node] of graphModel.nodes) {
            if (!node.expanded) toExpand.push(node);
        }

        if (toExpand.length === 0) {
            updateInfo('All nodes are already expanded');
            return;
        }

        setLoading(true);
        updateInfo('Expanding ' + toExpand.length + ' nodes...');

        let totalNew = 0;
        for (const node of toExpand) {
            try {
                const result = await graphModel.expandNode(node.id);
                totalNew += result.newNodes.length;
            } catch (e) {
                if (e.status === 401 || e.status === 403) {
                    updateInfo('Session expired or access denied. Refresh the page.');
                    setLoading(false);
                    return;
                }
                console.warn('KB Graph: could not expand ' + node.id, e.message);
            }
        }

        // Update graph renderer with all new data
        renderer.addIncremental(
            graphModel.getNodesArray(),
            graphModel.getLinksArray()
        );

        // Fetch titles for new nodes
        graphModel.fetchTitlesForUnexpanded().then(function (updated) {
            if (updated.length > 0) {
                renderer.updateLabels();
                if (currentView === 'tree') {
                    const centralId = graphModel.getNodesArray()[0]?.id;
                    treeRenderer.render(graphModel, centralId);
                }
            }
        });

        // Refresh tree view
        if (currentView === 'tree') {
            const centralId = graphModel.getNodesArray()[0]?.id;
            treeRenderer.render(graphModel, centralId);
        }

        selectedNode = null;
        updateNodeCount();
        updateInfo('Expanded ' + toExpand.length + ' nodes, found ' + totalNew + ' new articles');
        setLoading(false);
    }

    /** Collapse all nodes in tree view */
    function handleCollapseAll() {
        if (!treeRenderer || !graphModel) return;
        // Add all expanded nodes to the collapsed set
        for (const [id, node] of graphModel.nodes) {
            if (node.expanded) {
                treeRenderer.collapsedNodes.add(id);
            }
        }
        const centralId = graphModel.getNodesArray()[0]?.id;
        treeRenderer.render(graphModel, centralId);
        updateInfo('All nodes collapsed');
    }

    // ─── Toggle Button ───────────────────────────────────────────

    function addToggleButton() {
        if (document.getElementById('kb-graph-toggle-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'kb-graph-toggle-btn';
        btn.textContent = 'KB Graph View';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '80px',
            right: '20px',
            zIndex: '9999',
            padding: '10px 16px',
            fontSize: '13px',
            fontWeight: '500',
            background: COLORS.central,
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            transition: 'all 0.2s',
        });

        btn.onmouseover = function () {
            btn.style.background = COLORS.hover;
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
        };
        btn.onmouseout = function () {
            btn.style.background = COLORS.central;
            btn.style.transform = 'translateY(0)';
            btn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
        };

        btn.onclick = async function () {
            showPanel();
            if (!initialized) {
                setLoading(true);
                try {
                    await initializeGraph();
                } catch (e) {
                    updateInfo('Error initializing graph: ' + e.message);
                    console.error('KB Graph init error:', e);
                } finally {
                    setLoading(false);
                }
            }
        };

        document.body.appendChild(btn);
    }

    // ─── Entry Point ─────────────────────────────────────────────
    setTimeout(addToggleButton, 3000);
})();
