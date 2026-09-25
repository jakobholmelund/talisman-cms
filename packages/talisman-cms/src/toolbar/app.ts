import { defineToolbarApp } from 'astro/toolbar';
import { adminPath, collections, globals, uiLibraries } from 'virtual:talisman-cms/config';

// Everything shown comes from the integration's resolved config, so a custom adminPath and the
// collections, globals and UI libraries of the installed plugins appear as configured.
const adminHome = adminPath || '/admin';
const adminPrefix = adminHome === '/' ? '' : adminHome;

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

// Mirrors the admin's own sections (ui/lib/admin-sections.ts).
function collectionHref(collection: (typeof collections)[number]) {
  if (collection.slug === 'media') return `${adminPrefix}/media`;
  const commerce = collection.adminSection === 'commerce' ||
    (!collection.adminSection && (collection.nativeSchemaMapping?.schemaPath === '@talisman-cms/plugin-ecommerce/schema' ||
      collection.slug.startsWith('_ecommerce_')));
  return `${adminPrefix}/${commerce ? 'commerce' : 'collections'}/${encodeURIComponent(collection.slug)}`;
}

function chipLinks(items: Array<{ label: string; href: string }>, empty: string) {
  if (!items.length) return `<span class="talisman-empty">${escapeHtml(empty)}</span>`;
  return items.map(({ label, href }) =>
    `<a class="talisman-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`).join('');
}

export default defineToolbarApp({
  init(canvas, app) {
    let windowElement: HTMLElement | null = null;

    // The CMS health route runs `SELECT 1` against the DB binding; it needs no session.
    const checkDatabase = async (target: HTMLElement) => {
      try {
        const response = await fetch(`${adminPrefix}/api/health`, { headers: { Accept: 'application/json' } });
        const body = (await response.json().catch(() => null)) as { d1?: unknown; message?: unknown } | null;
        const connected = response.ok && body?.d1 === 'connected';
        target.dataset.state = connected ? 'ok' : 'error';
        target.querySelector('span')!.textContent = connected
          ? 'D1 binding DB: connected'
          : `D1 binding DB: ${typeof body?.message === 'string' ? body.message : `health check returned HTTP ${response.status}`}`;
      } catch (error) {
        target.dataset.state = 'error';
        target.querySelector('span')!.textContent = `D1 binding DB: health check failed (${error instanceof Error ? error.message : 'network error'})`;
      }
    };

    const renderUI = () => {
      const currentPath = window.location.pathname;
      const collectionLinks = collections.map((collection) => ({ label: collection.name || collection.slug, href: collectionHref(collection) }));
      const globalLinks = globals.map((global) => ({ label: global.name || global.slug, href: `${adminPrefix}/globals/${encodeURIComponent(global.slug)}` }));
      const firstCollection = collections.find((collection) => collection.slug !== 'media' && !collection.slug.startsWith('_'));

      const container = document.createElement('astro-dev-toolbar-window');
      container.style.cssText = `
        padding: 20px;
        min-width: 360px;
        max-width: 440px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #f4f4f5;
        background: #09090b;
        border: 1px solid #27272a;
        border-radius: 12px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
      `;

      container.innerHTML = `
        <style>
          .talisman-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid #27272a;
          }
          .talisman-brand {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .talisman-brand h2 {
            font-size: 16px;
            font-weight: 700;
            margin: 0;
            color: #fafafa;
            letter-spacing: -0.01em;
          }
          .talisman-badge {
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 9999px;
            background: rgba(99, 102, 241, 0.2);
            color: #a5b4fc;
            border: 1px solid rgba(99, 102, 241, 0.4);
          }
          .talisman-actions {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-bottom: 16px;
          }
          .talisman-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 8px 12px;
            font-size: 13px;
            font-weight: 600;
            border-radius: 6px;
            text-decoration: none;
            cursor: pointer;
            transition: all 0.15s ease;
          }
          .talisman-btn-primary {
            background: #6366f1;
            color: #ffffff;
            border: 1px solid #4f46e5;
          }
          .talisman-btn-primary:hover {
            background: #4f46e5;
          }
          .talisman-btn-secondary {
            background: #18181b;
            color: #d4d4d8;
            border: 1px solid #27272a;
          }
          .talisman-btn-secondary:hover {
            background: #27272a;
            color: #ffffff;
          }
          .talisman-btn-toggle {
            grid-column: span 2;
            background: rgba(99, 102, 241, 0.15);
            color: #a5b4fc;
            border: 1px dashed rgba(99, 102, 241, 0.5);
          }
          .talisman-btn-toggle:hover {
            background: rgba(99, 102, 241, 0.25);
          }
          .talisman-section {
            margin-bottom: 14px;
          }
          .talisman-section-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #71717a;
            margin-bottom: 8px;
          }
          .talisman-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
          }
          .talisman-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            padding: 4px 8px;
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 6px;
            color: #e4e4e7;
          }
          a.talisman-chip:hover {
            border-color: #6366f1;
            color: #ffffff;
          }
          .talisman-empty {
            font-size: 12px;
            color: #71717a;
          }
          .talisman-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #71717a;
          }
          [data-state="ok"] .talisman-status-dot {
            background: #10b981;
          }
          [data-state="error"] .talisman-status-dot {
            background: #ef4444;
          }
          .talisman-footer {
            margin-top: 16px;
            padding-top: 10px;
            border-top: 1px solid #27272a;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
            color: #71717a;
          }
        </style>

        <div class="talisman-header">
          <div class="talisman-brand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="9" stroke="#818cf8" stroke-width="2"/>
              <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)" stroke="#c084fc" stroke-width="1.5"/>
              <circle cx="12" cy="12" r="3" fill="#6366f1"/>
            </svg>
            <h2>Talisman CMS</h2>
          </div>
          <span class="talisman-badge">${escapeHtml(adminHome)}</span>
        </div>

        <div class="talisman-actions">
          <a href="${escapeHtml(adminHome)}" target="_blank" rel="noopener" class="talisman-btn talisman-btn-primary">
            Open Admin ↗
          </a>
          ${firstCollection ? `<a href="${escapeHtml(collectionHref(firstCollection))}" target="_blank" rel="noopener" class="talisman-btn talisman-btn-secondary">
            Edit ${escapeHtml(firstCollection.name || firstCollection.slug)}
          </a>` : `<a href="${escapeHtml(`${adminPrefix}/collections`)}" target="_blank" rel="noopener" class="talisman-btn talisman-btn-secondary">
            Collections
          </a>`}
          <button type="button" id="talisman-toggle-inspector" class="talisman-btn talisman-btn-toggle">
            🔍 Inspect Layout Blocks
          </button>
        </div>

        <div class="talisman-section">
          <div class="talisman-section-title">Current Route</div>
          <div class="talisman-chip" style="width: 100%;">
            <span>Path: <code>${escapeHtml(currentPath)}</code></span>
          </div>
        </div>

        <div class="talisman-section">
          <div class="talisman-section-title">Collections (${collectionLinks.length})</div>
          <div class="talisman-list">${chipLinks(collectionLinks, 'None configured')}</div>
        </div>

        <div class="talisman-section">
          <div class="talisman-section-title">Globals (${globalLinks.length})</div>
          <div class="talisman-list">${chipLinks(globalLinks, 'None configured')}</div>
        </div>

        <div class="talisman-section">
          <div class="talisman-section-title">UI Libraries</div>
          <div class="talisman-list">
            ${uiLibraries.length
              ? uiLibraries.map((library) => `<span class="talisman-chip">${escapeHtml(library.name || library.id)}</span>`).join('')
              : '<span class="talisman-empty">None registered</span>'}
          </div>
        </div>

        <div class="talisman-footer">
          <div id="talisman-db-status" style="display: flex; align-items: center; gap: 6px;">
            <div class="talisman-status-dot"></div>
            <span>D1 binding DB: checking…</span>
          </div>
        </div>
      `;

      const dbStatus = container.querySelector<HTMLElement>('#talisman-db-status');
      if (dbStatus) void checkDatabase(dbStatus);

      const inspectorBtn = container.querySelector('#talisman-toggle-inspector');
      let inspectorActive = false;

      inspectorBtn?.addEventListener('click', () => {
        inspectorActive = !inspectorActive;
        const blocks = document.querySelectorAll('[data-talisman-block]');
        
        if (inspectorActive) {
          inspectorBtn.textContent = '✕ Exit Block Inspector';
          (inspectorBtn as HTMLElement).style.background = 'rgba(239, 68, 68, 0.2)';
          (inspectorBtn as HTMLElement).style.color = '#fca5a5';
          (inspectorBtn as HTMLElement).style.borderColor = 'rgba(239, 68, 68, 0.4)';

          blocks.forEach((el) => {
            const htmlEl = el as HTMLElement;
            htmlEl.style.outline = '2px dashed #6366f1';
            htmlEl.style.outlineOffset = '4px';

            const blockType = htmlEl.getAttribute('data-talisman-block') || 'block';
            const blockIndex = htmlEl.getAttribute('data-talisman-block-index') || '0';

            const badge = document.createElement('div');
            badge.className = 'talisman-block-badge';
            badge.style.cssText = `
              position: absolute;
              top: 8px;
              left: 8px;
              z-index: 1000;
              background: #4f46e5;
              color: #ffffff;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 700;
              letter-spacing: 0.05em;
              box-shadow: 0 4px 6px rgba(0,0,0,0.3);
              cursor: pointer;
            `;
            badge.textContent = `🧩 ${blockType} #${blockIndex} ↗`;
            badge.title = 'Click to edit in Talisman CMS';
            badge.addEventListener('click', (e) => {
              e.stopPropagation();
              window.open(adminHome, '_blank', 'noopener');
            });

            htmlEl.style.position = 'relative';
            htmlEl.appendChild(badge);
          });
        } else {
          inspectorBtn.textContent = '🔍 Inspect Layout Blocks';
          (inspectorBtn as HTMLElement).style.background = 'rgba(99, 102, 241, 0.15)';
          (inspectorBtn as HTMLElement).style.color = '#a5b4fc';
          (inspectorBtn as HTMLElement).style.borderColor = 'rgba(99, 102, 241, 0.5)';

          blocks.forEach((el) => {
            const htmlEl = el as HTMLElement;
            htmlEl.style.outline = '';
            htmlEl.style.outlineOffset = '';
            htmlEl.querySelectorAll('.talisman-block-badge').forEach((b) => b.remove());
          });
        }
      });

      return container;
    };

    app.onToggled(({ state }) => {
      if (state) {
        windowElement = renderUI();
        canvas.appendChild(windowElement);
      } else if (windowElement) {
        // Clean up inspector on close
        document.querySelectorAll('[data-talisman-block]').forEach((el) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.outline = '';
          htmlEl.style.outlineOffset = '';
          htmlEl.querySelectorAll('.talisman-block-badge').forEach((b) => b.remove());
        });
        windowElement.remove();
        windowElement = null;
      }
    });
  }
});
