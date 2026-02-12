# ServiceNow Tampermonkey Scripts

A collection of [Tampermonkey](https://www.tampermonkey.net/) userscripts that enhance the ServiceNow Knowledge Base experience.

**Author:** [Joan Marc Riera](https://www.linkedin.com/in/joanmarcriera/)

---

## Scripts

| Script | Description | Version |
|--------|-------------|---------|
| [KB Graph View](#-kb-graph-view) | Obsidian-like interactive graph of linked KB articles | 1.2 |
| [KB Reverse Links](#-kb-reverse-links) | Show which KB articles and tasks reference the current article | 1.0 |
| [KB Obsidian Export](#-kb-obsidian-export) | Export KB articles to Obsidian-flavoured Markdown | 1.2 |

---

## Prerequisites

1. **Install Tampermonkey** for your browser:
   - [Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
   - [Safari](https://apps.apple.com/app/tampermonkey/id1482490089)

2. **ServiceNow access** &mdash; you need to be logged into your ServiceNow instance. The scripts work on any instance (they match `*/kb_view.do*` and `*/kb_article.do*`).

---

## Installation

### Option A &mdash; Install from file (recommended)

1. Open Tampermonkey in your browser and go to the **Dashboard**.
2. Click the **Utilities** tab.
3. Under **Import from file**, choose the `.user.js` / `.script` file you want to install.
4. Tampermonkey will show the script source &mdash; click **Install**.

### Option B &mdash; Copy &amp; paste

1. Open Tampermonkey **Dashboard** &rarr; click the **`+`** tab to create a new script.
2. Delete the template code.
3. Paste the full contents of the script file.
4. Press **Ctrl+S** / **Cmd+S** to save.

### Option C &mdash; Install directly from GitHub

Click the raw file link for each script below. Tampermonkey will detect it and offer to install:

- [`servicenow-kb-graph-view.user.js`](servicenow/servicenow-kb-graph-view.user.js)
- [`servicenow-kb-reverse-links.user.js`](servicenow/servicenow-kb-reverse-links.user.js)
- [`servicenow-to-obisidian-markdown.script`](servicenow/servicenow-to-obisidian-markdown.script)

> **Note:** For the direct-install to work the file must have a `.user.js` extension and be served as raw content.

---

## Scripts in Detail

### KB Graph View

**File:** [`servicenow/servicenow-kb-graph-view.user.js`](servicenow/servicenow-kb-graph-view.user.js)

An interactive, Obsidian-style graph visualisation that shows how ServiceNow Knowledge Base articles link to each other. Built with [D3.js](https://d3js.org/).

#### Features

- **Force-directed graph** &mdash; central node (current article) with linked KB articles around it
- **Expand on demand** &mdash; double-click any node to fetch its linked articles via the ServiceNow Table API
- **Tree view** &mdash; toggle to a collapsible tree that highlights duplicate/convergent links with badges
- **Expand All / Collapse All** &mdash; bulk-expand the next level of links or fold the tree back up
- **Open in new tab** &mdash; right-click a node or click the footer link to open the article
- **Drag, zoom &amp; pan** &mdash; full interactivity on the graph canvas
- **Resizable panel** &mdash; drag the bottom-right corner to resize
- **Background title fetching** &mdash; article titles are fetched in parallel so labels always show `KB_NUMBER - Title`

#### Screenshots

**Graph view:**

<img width="1440" height="1039" alt="Graph view showing linked KB articles as an interactive force-directed network" src="https://github.com/user-attachments/assets/625a27ad-99f0-43dd-b6dc-77d1fada0017" />

**Tree view:**

<img width="1155" height="1143" alt="Tree view showing hierarchical article links with duplicate detection badges" src="https://github.com/user-attachments/assets/4267698b-fd98-4f6a-9bc7-e3cb09b32d31" />

**Reverse links:**

<img width="408" height="627" alt="image" src="https://github.com/user-attachments/assets/c71abe1f-338c-4b79-b663-ee0291902329" />


#### How it works

1. Navigate to any ServiceNow KB article (`kb_view.do` or `kb_article.do`).
2. A purple **"KB Graph View"** button appears in the bottom-right corner (after ~3s).
3. Click it to open the graph panel.
4. **Double-click** a node to expand it (fetches linked articles via the REST API).
5. **Right-click** a node to open that article in a new tab.
6. Use the footer buttons to switch between **Graph** and **Tree** views, **Fit to View**, **Reset Zoom**, or **Expand All**.

#### Requirements

- ServiceNow Table API access (`/api/now/table/kb_knowledge`) &mdash; requires read permission on the `kb_knowledge` table.
- The script uses your existing browser session (`window.g_ck` token) for authentication; no credentials are stored.

---

### KB Reverse Links

**File:** [`servicenow/servicenow-kb-reverse-links.user.js`](servicenow/servicenow-kb-reverse-links.user.js)

Shows which other KB articles and tasks (incidents, catalog tasks, etc.) reference the currently viewed KB article &mdash; the "incoming links" complement to the Graph View's outgoing links.

#### Features

- **Reverse KB references** &mdash; queries the `kb_2_kb` relationship table to find KB articles that link to the current one
- **Task references** &mdash; queries the `m2m_kb_task` table to find incidents, catalog tasks, change requests, and other tasks that reference this article
- **Auto schema discovery** &mdash; automatically detects the field names on `kb_2_kb` (which vary by ServiceNow instance) via a one-time discovery query
- **Clickable results** &mdash; click any row or the &nearr; icon to open the referenced article or task in a new tab
- **Task type badges** &mdash; each task shows its type (Incident, Catalog Task, Change, etc.)
- **Graceful error handling** &mdash; each section loads independently, so if one table is inaccessible the other still works
- **Refresh button** &mdash; re-fetch the latest reverse links without reloading the page

#### How it works

1. Navigate to any ServiceNow KB article (`kb_view.do`, `kb_article.do`, or `esc?id=kb_article`).
2. A sky-blue **"Reverse Links"** button appears in the bottom-right corner (after ~3s).
3. Click it to open the reverse links panel.
4. The script resolves the article's `sys_id`, then queries both relationship tables in parallel.
5. Results are displayed in two sections: **KB Articles** (purple dots) and **Tasks** (amber dots).

#### Requirements

- ServiceNow Table API access to `kb_knowledge`, `kb_2_kb`, and `m2m_kb_task` tables.
- If `kb_2_kb` is not accessible, the KB references section will show an error message while the tasks section still works (and vice versa).
- Uses your existing browser session (`window.g_ck` token) for authentication.

---

### KB Obsidian Export

**File:** [`servicenow/servicenow-to-obisidian-markdown.script`](servicenow/servicenow-to-obisidian-markdown.script)

Exports the current ServiceNow KB article as a clean Markdown file ready for [Obsidian](https://obsidian.md/), with proper `[[wikilinks]]` to other KB articles.

#### Features

- Extracts the article body from the page (no UI chrome or scripts)
- Converts internal KB links to Obsidian `[[KB_NUMBER|Label]]` wikilinks
- Preserves links to ServiceNow incidents, catalogs, and Google Docs
- Downloads as a `.md` file named after the KB number

#### How it works

1. Navigate to any ServiceNow KB article.
2. An **"Export to Obsidian (Clean MD)"** button appears in the bottom-right corner.
3. Click it to download the Markdown file.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Buttons don't appear | Wait a few seconds for ServiceNow to finish rendering. Check that Tampermonkey is enabled and the script is active for the current URL. |
| "Session expired" error | Refresh the ServiceNow page to get a new session token, then reopen the graph. |
| API errors (403/404) | Ensure your ServiceNow role has read access to `kb_knowledge`. For reverse links, you also need access to `kb_2_kb` and `m2m_kb_task`. |
| Graph is empty | The article may not contain links to other KB articles. Check the article body for `<a>` tags pointing to `kb_view.do` or `kb_article`. |

---

## License

These scripts are provided as-is for personal use.

**Author:** [Joan Marc Riera](https://www.linkedin.com/in/joanmarcriera/)
