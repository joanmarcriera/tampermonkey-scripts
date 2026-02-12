// ==UserScript==
// @name         ServiceNow KB Graph View
// @namespace    https://example.com/snow-kb-graph
// @version      1.0
// @description  Obsidian-like graph visualization of linked ServiceNow Knowledge Base articles
// @match        *://*/kb_view.do*
// @match        *://*/kb_article.do*
// @require      https://d3js.org/d3.v7.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ─── Constants ───────────────────────────────────────────────
    const MAX_NODES = 100;
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
    };
    const NODE_RADIUS = { central: 16, depth1: 10, depth2: 8, deep: 6 };

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
            const node = { id, label, depth, expanded: false };
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

            // Update label if we got a better title from the API
            if (articleData.title && articleData.title !== kbNumber) {
                node.label = articleData.title;
            }

            const kbLinks = extractKbLinks(articleData.html);

            for (const link of kbLinks) {
                if (link.kb === kbNumber) continue; // skip self-links
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

        render(nodes, links, onExpand, onSelect) {
            this.onExpand = onExpand;
            this.onSelect = onSelect;
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

        fitToView() {
            const g = this.svg.select('.graph-root');
            const bounds = g.node().getBBox();
            if (bounds.width === 0 || bounds.height === 0) return;

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

            // Animate new nodes in
            nodeEnter.attr('r', 0)
                .transition().duration(300)
                .attr('r', d => self._nodeRadius(d));

            // Update existing node colors (for expanded state)
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
                .text(d => {
                    const maxLen = d.id === self.centralId ? 40 : 25;
                    return d.label.length > maxLen ? d.label.substring(0, maxLen) + '...' : d.label;
                });

            // Update label text for nodes that got better titles
            labelSel.text(d => {
                const maxLen = d.id === self.centralId ? 40 : 25;
                return d.label.length > maxLen ? d.label.substring(0, maxLen) + '...' : d.label;
            });
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
            maxWidth: '1200px', maxHeight: '800px',
            background: COLORS.bgPrimary,
            border: `1px solid ${COLORS.border}`,
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
            borderBottom: `1px solid ${COLORS.border}`,
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
        closeBtn.onmouseover = () => closeBtn.style.color = COLORS.textPrimary;
        closeBtn.onmouseout = () => closeBtn.style.color = COLORS.textSecondary;
        closeBtn.onclick = () => hidePanel();

        titleBar.appendChild(titleText);
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
            border: `3px solid ${COLORS.border}`,
            borderTop: `3px solid ${COLORS.central}`,
            borderRadius: '50%',
            animation: 'kb-graph-spin 1s linear infinite',
        });
        loading.appendChild(spinner);
        graphContainer.appendChild(loading);

        // Footer / controls
        const footer = document.createElement('div');
        footer.id = 'kb-graph-footer';
        Object.assign(footer.style, {
            background: COLORS.bgSecondary,
            borderTop: `1px solid ${COLORS.border}`,
            padding: '8px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: '0',
            fontSize: '12px',
            color: COLORS.textSecondary,
        });

        const infoText = document.createElement('span');
        infoText.id = 'kb-graph-info';
        infoText.textContent = 'Double-click a node to expand';

        const controlsRight = document.createElement('div');
        controlsRight.style.display = 'flex';
        controlsRight.style.gap = '6px';

        const makeBtnStyle = (btn) => {
            Object.assign(btn.style, {
                background: COLORS.bgPrimary,
                border: `1px solid ${COLORS.border}`,
                color: COLORS.textPrimary,
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '11px',
                cursor: 'pointer',
            });
            btn.onmouseover = () => btn.style.background = COLORS.border;
            btn.onmouseout = () => btn.style.background = COLORS.bgPrimary;
        };

        const fitBtn = document.createElement('button');
        fitBtn.textContent = 'Fit to View';
        fitBtn.id = 'kb-graph-fit-btn';
        makeBtnStyle(fitBtn);

        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset Zoom';
        resetBtn.id = 'kb-graph-reset-btn';
        makeBtnStyle(resetBtn);

        controlsRight.appendChild(fitBtn);
        controlsRight.appendChild(resetBtn);
        footer.appendChild(infoText);
        footer.appendChild(controlsRight);

        panel.appendChild(titleBar);
        panel.appendChild(graphContainer);
        panel.appendChild(footer);
        overlay.appendChild(panel);

        // Inject spin animation
        const style = document.createElement('style');
        style.textContent = '@keyframes kb-graph-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);

        // Make panel draggable
        let isDragging = false, dragOffX = 0, dragOffY = 0;
        titleBar.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffX = e.clientX - rect.left;
            dragOffY = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = (e.clientX - dragOffX) + 'px';
            panel.style.top = (e.clientY - dragOffY) + 'px';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });

        // Close on overlay click (outside panel)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hidePanel();
        });

        document.body.appendChild(overlay);
        return { overlay, panel, graphContainer, loading, titleText, infoText, fitBtn, resetBtn };
    }

    // ─── State ───────────────────────────────────────────────────

    let panelElements = null;
    let graphModel = null;
    let renderer = null;
    let initialized = false;

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

    function updateInfo(text) {
        if (panelElements) panelElements.infoText.textContent = text;
    }

    function updateNodeCount() {
        if (!graphModel) return;
        const count = graphModel.nodes.size;
        const linkCount = graphModel.links.size;
        updateInfo(`${count} nodes, ${linkCount} links \u2022 Double-click to expand`);
    }

    // ─── Orchestration ───────────────────────────────────────────

    async function initializeGraph() {
        const kbNumber = getKbNumber();
        const title = getArticleTitle();

        if (!kbNumber) {
            updateInfo('Could not detect KB article number');
            return;
        }

        panelElements.titleText.textContent = `KB Graph View \u2014 ${kbNumber}`;

        graphModel = new GraphModel();
        graphModel.addNode(kbNumber, title, 0);

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

        // Initialize renderer
        renderer = new GraphRenderer(panelElements.graphContainer, kbNumber);
        renderer.initialize();

        // Wire up controls
        panelElements.fitBtn.onclick = () => renderer.fitToView();
        panelElements.resetBtn.onclick = () => renderer.resetZoom();

        // Render
        renderer.render(
            graphModel.getNodesArray(),
            graphModel.getLinksArray(),
            handleExpand,
            handleSelect
        );

        updateNodeCount();
        initialized = true;

        // Auto fit after simulation settles a bit
        setTimeout(() => renderer.fitToView(), 1500);
    }

    async function handleExpand(node) {
        if (node.expanded) {
            updateInfo(`${node.id} is already expanded`);
            return;
        }

        setLoading(true);
        updateInfo(`Loading ${node.id}...`);

        try {
            const { newNodes, newLinks } = await graphModel.expandNode(node.id);

            if (newNodes.length === 0 && newLinks.length === 0) {
                updateInfo(`${node.id} has no linked KB articles`);
            } else {
                renderer.addIncremental(
                    graphModel.getNodesArray(),
                    graphModel.getLinksArray()
                );
                updateNodeCount();
            }
        } catch (e) {
            if (e.status === 401 || e.status === 403) {
                updateInfo('Session expired or access denied. Refresh the page.');
            } else if (e.status === 404) {
                updateInfo(`${node.id} not found or not accessible`);
                node.expanded = true; // mark to prevent re-trying
            } else {
                updateInfo(`Error loading ${node.id}: ${e.message}`);
            }
            console.error('KB Graph expand error:', e);
        } finally {
            setLoading(false);
        }
    }

    function handleSelect(node) {
        updateInfo(`${node.id}: ${node.label}${node.expanded ? ' (expanded)' : ''}`);
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

        btn.onmouseover = () => {
            btn.style.background = COLORS.hover;
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 4px 8px rgba(0,0,0,0.3)';
        };
        btn.onmouseout = () => {
            btn.style.background = COLORS.central;
            btn.style.transform = 'translateY(0)';
            btn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
        };

        btn.onclick = async () => {
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
