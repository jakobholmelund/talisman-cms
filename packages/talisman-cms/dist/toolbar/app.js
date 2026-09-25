import "../chunk-MLKGABMK.js";

// src/toolbar/app.ts
import { defineToolbarApp } from "astro/toolbar";
var app_default = defineToolbarApp({
  init(canvas, app) {
    let windowElement = null;
    const renderUI = () => {
      const currentPath = window.location.pathname;
      const container = document.createElement("astro-dev-toolbar-window");
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
          .talisman-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #10b981;
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
          <span class="talisman-badge">Astro 7 Ready</span>
        </div>

        <div class="talisman-actions">
          <a href="/admin" target="_blank" class="talisman-btn talisman-btn-primary">
            Open Admin \u2197
          </a>
          <a href="/admin/collections/pages" target="_blank" class="talisman-btn talisman-btn-secondary">
            Edit Pages
          </a>
          <button type="button" id="talisman-toggle-inspector" class="talisman-btn talisman-btn-toggle">
            \u{1F50D} Inspect Layout Blocks
          </button>
        </div>

        <div class="talisman-section">
          <div class="talisman-section-title">Current Route Context</div>
          <div class="talisman-chip" style="width: 100%; justify-content: space-between;">
            <span>Path: <code>${currentPath}</code></span>
            <span style="color: #a1a1aa;">Edge SSR</span>
          </div>
        </div>

        <div class="talisman-section">
          <div class="talisman-section-title">CMS Collections</div>
          <div class="talisman-list">
            <span class="talisman-chip">\u{1F4C4} pages</span>
            <span class="talisman-chip">\u{1F4DD} posts</span>
            <span class="talisman-chip">\u{1F6CD}\uFE0F products</span>
            <span class="talisman-chip">\u{1F5BC}\uFE0F media</span>
            <span class="talisman-chip">\u{1F9E9} presets</span>
          </div>
        </div>

        <div class="talisman-section">
          <div class="talisman-section-title">Active Plugins</div>
          <div class="talisman-list">
            <span class="talisman-chip">ecommerce</span>
            <span class="talisman-chip">stripe</span>
            <span class="talisman-chip">daisyui</span>
            <span class="talisman-chip">starwind</span>
          </div>
        </div>

        <div class="talisman-footer">
          <div style="display: flex; align-items: center; gap: 6px;">
            <div class="talisman-status-dot"></div>
            <span>Cloudflare D1 + KV Active</span>
          </div>
          <span>v0.1.0</span>
        </div>
      `;
      const inspectorBtn = container.querySelector("#talisman-toggle-inspector");
      let inspectorActive = false;
      inspectorBtn?.addEventListener("click", () => {
        inspectorActive = !inspectorActive;
        const blocks = document.querySelectorAll("[data-talisman-block]");
        if (inspectorActive) {
          inspectorBtn.textContent = "\u2715 Exit Block Inspector";
          inspectorBtn.style.background = "rgba(239, 68, 68, 0.2)";
          inspectorBtn.style.color = "#fca5a5";
          inspectorBtn.style.borderColor = "rgba(239, 68, 68, 0.4)";
          blocks.forEach((el) => {
            const htmlEl = el;
            htmlEl.style.outline = "2px dashed #6366f1";
            htmlEl.style.outlineOffset = "4px";
            const blockType = htmlEl.getAttribute("data-talisman-block") || "block";
            const blockIndex = htmlEl.getAttribute("data-talisman-block-index") || "0";
            const badge = document.createElement("div");
            badge.className = "talisman-block-badge";
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
            badge.textContent = `\u{1F9E9} ${blockType} #${blockIndex} \u2197`;
            badge.title = "Click to edit in Talisman CMS";
            badge.addEventListener("click", (e) => {
              e.stopPropagation();
              window.open("/admin", "_blank");
            });
            htmlEl.style.position = "relative";
            htmlEl.appendChild(badge);
          });
        } else {
          inspectorBtn.textContent = "\u{1F50D} Inspect Layout Blocks";
          inspectorBtn.style.background = "rgba(99, 102, 241, 0.15)";
          inspectorBtn.style.color = "#a5b4fc";
          inspectorBtn.style.borderColor = "rgba(99, 102, 241, 0.5)";
          blocks.forEach((el) => {
            const htmlEl = el;
            htmlEl.style.outline = "";
            htmlEl.style.outlineOffset = "";
            htmlEl.querySelectorAll(".talisman-block-badge").forEach((b) => b.remove());
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
        document.querySelectorAll("[data-talisman-block]").forEach((el) => {
          const htmlEl = el;
          htmlEl.style.outline = "";
          htmlEl.style.outlineOffset = "";
          htmlEl.querySelectorAll(".talisman-block-badge").forEach((b) => b.remove());
        });
        windowElement.remove();
        windowElement = null;
      }
    });
  }
});
export {
  app_default as default
};
