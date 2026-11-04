/**
 * The panel's stylesheet, injected once as a `<style>` element.
 *
 * A CSS file would need a loader in the client build; a template string needs nothing, keeps the
 * bundle self-contained, and lets the whole look live in one file. Class names are prefixed `jl-`
 * so they cannot collide with the host's own styles.
 *
 * @module dsh-job-ledger/client/styles
 */

/** Element id, so a hot reload replaces the sheet instead of stacking copies. */
export const STYLE_ID = 'dsh-job-ledger-style'

/** The sheet. Kept in one string so the design tokens are visible in one place. */
export const CSS = `
.jl-root {
  --jl-ink: #101828;
  --jl-muted: #667085;
  --jl-faint: #98a2b3;
  --jl-line: #e4e7ec;
  --jl-surface: #ffffff;
  --jl-surface-2: #f8fafc;
  --jl-accent: #4f46e5;
  --jl-accent-ink: #ffffff;
  --jl-accent-weak: #eef2ff;
  --jl-ok: #087443;
  --jl-ok-weak: #ecfdf3;
  --jl-warn: #b54708;
  --jl-warn-weak: #fffaeb;
  --jl-danger: #b42318;
  --jl-danger-weak: #fef3f2;
  --jl-radius: 14px;
  --jl-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06);
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 1040px;
  margin: 0 auto;
  padding: 26px 24px 40px;
  /* The host's main column clips its content (overflow: hidden) instead of scrolling, so the panel
     scrolls itself; without this a long queue is cut off and the apply bar is unreachable. */
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  color: var(--jl-ink);
  font-size: 14px;
  line-height: 1.55;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.jl-root *, .jl-root *::before, .jl-root *::after { box-sizing: border-box; }
@media (prefers-color-scheme: dark) {
  .jl-root {
    --jl-ink: #e6e9f0;
    --jl-muted: #98a2b3;
    --jl-faint: #667085;
    --jl-line: #232a36;
    --jl-surface: #131822;
    --jl-surface-2: #0d1117;
    --jl-accent: #a5b4fc;
    --jl-accent-ink: #1e1b4b;
    --jl-accent-weak: #1e1b4b;
    --jl-ok: #6ce9a6;
    --jl-ok-weak: #05603a;
    --jl-warn: #fdb022;
    --jl-warn-weak: #4e1d09;
    --jl-danger: #fda29b;
    --jl-danger-weak: #55160c;
    --jl-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }
}

.jl-root button, .jl-root input { font: inherit; color: inherit; }
.jl-root button { cursor: pointer; }
.jl-root button:disabled { cursor: not-allowed; }
.jl-root :focus-visible { outline: 2px solid var(--jl-accent); outline-offset: 2px; }

/* ---- header ---- */
.jl-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.jl-title { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
.jl-sub { margin: 2px 0 0; color: var(--jl-muted); font-size: 12px; }
.jl-head-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.jl-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--jl-line); background: var(--jl-surface-2);
  color: var(--jl-muted); font-size: 12px; white-space: nowrap;
}
.jl-pill.is-running { color: var(--jl-accent); border-color: transparent; background: var(--jl-accent-weak); }
.jl-pill.is-danger { color: var(--jl-danger); border-color: transparent; background: var(--jl-danger-weak); }
.jl-pill.is-ok { color: var(--jl-ok); border-color: transparent; background: var(--jl-ok-weak); }
.jl-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }

/* ---- tabs ---- */
.jl-tabs {
  display: inline-flex; gap: 2px; padding: 4px;
  background: var(--jl-surface-2); border: 1px solid var(--jl-line);
  border-radius: 12px; align-self: flex-start; flex: none; max-width: 100%; overflow-x: auto;
}
.jl-tab {
  display: inline-flex; align-items: center; gap: 7px;
  border: 0; background: transparent; color: var(--jl-muted);
  padding: 7px 14px; border-radius: 9px; font-size: 13px; font-weight: 500; white-space: nowrap;
}
.jl-tab:hover { color: var(--jl-ink); }
.jl-tab[aria-selected="true"] {
  background: var(--jl-surface); color: var(--jl-ink); font-weight: 600;
  box-shadow: var(--jl-shadow); border: 1px solid var(--jl-line); padding: 6px 13px;
}
.jl-badge {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--jl-accent-weak); color: var(--jl-accent); font-size: 11px; font-weight: 600;
}
.jl-badge.is-danger { background: var(--jl-danger-weak); color: var(--jl-danger); }

/* ---- cards ---- */
.jl-card { background: var(--jl-surface); border: 1px solid var(--jl-line); border-radius: var(--jl-radius); box-shadow: var(--jl-shadow); overflow: hidden; }
/* A queue card fills the panel and scrolls only its rows, so the apply bar below the list stays put. */
.jl-card.is-fill { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.jl-card.is-fill > .jl-card-head { flex: none; }
.jl-card.is-fill > .jl-rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.jl-card.is-fill > .jl-empty { flex: 1 1 auto; overflow-y: auto; }
.jl-card.is-fill > .jl-actions { flex: none; position: static; }
.jl-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--jl-line); }
.jl-card-title { margin: 0; font-size: 14px; font-weight: 600; }
.jl-card-body { padding: 6px 0; }
.jl-card-body.is-padded { padding: 16px; }

/* ---- queue rows ---- */
.jl-rows { list-style: none; margin: 0; padding: 0; }
.jl-row { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--jl-line); }
.jl-row:last-child { border-bottom: 0; }
.jl-row:hover { background: var(--jl-surface-2); }
@media (prefers-reduced-motion: no-preference) { .jl-row { transition: background 120ms ease; } }
.jl-check { width: 16px; height: 16px; accent-color: var(--jl-accent); margin: 0; }
.jl-row-title { font-weight: 600; font-size: 14px; }
.jl-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 2px; color: var(--jl-muted); font-size: 12px; }
.jl-sep { color: var(--jl-faint); }
.jl-tag { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--jl-surface-2); border: 1px solid var(--jl-line); color: var(--jl-muted); }
.jl-tag.is-new { background: var(--jl-ok-weak); color: var(--jl-ok); border-color: transparent; }
.jl-tag.is-suspect { background: var(--jl-warn-weak); color: var(--jl-warn); border-color: transparent; }

/* ---- empty states ---- */
.jl-empty { padding: 36px 20px; text-align: center; color: var(--jl-muted); }
.jl-empty strong { display: block; color: var(--jl-ink); font-weight: 600; margin-bottom: 4px; }
.jl-empty span { font-size: 12px; }

/* ---- action bar ---- */
.jl-actions {
  position: sticky; bottom: 0; z-index: 2;
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 12px 16px; border-top: 1px solid var(--jl-line);
  background: color-mix(in srgb, var(--jl-surface) 88%, transparent);
  backdrop-filter: blur(8px);
}
.jl-actions-note { color: var(--jl-muted); font-size: 12px; }
.jl-btn { border: 1px solid var(--jl-line); background: var(--jl-surface); padding: 8px 14px; border-radius: 10px; font-size: 13px; font-weight: 550; }
.jl-btn:not(.is-primary):hover:not(:disabled) { background: var(--jl-surface-2); }
.jl-btn.is-primary { background: var(--jl-accent); border-color: transparent; color: var(--jl-accent-ink); }
.jl-btn.is-primary:hover:not(:disabled) { background: var(--jl-accent); filter: brightness(1.06); }
.jl-btn:disabled { opacity: 0.5; }
.jl-btn.is-ghost { border-color: transparent; background: transparent; color: var(--jl-muted); padding: 6px 8px; }
.jl-btn.is-ghost:hover:not(:disabled) { color: var(--jl-ink); background: var(--jl-surface-2); }

/* ---- stats ---- */
.jl-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.jl-stat { padding: 14px 16px; background: var(--jl-surface); border: 1px solid var(--jl-line); border-radius: 12px; box-shadow: var(--jl-shadow); }
.jl-stat-label { color: var(--jl-muted); font-size: 12px; }
.jl-stat-value { margin-top: 2px; font-size: 26px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.jl-stat.is-alert { border-color: color-mix(in srgb, var(--jl-danger) 35%, var(--jl-line)); }
.jl-stat.is-alert .jl-stat-value { color: var(--jl-danger); }
.jl-stat.is-warn { border-color: color-mix(in srgb, var(--jl-warn) 30%, var(--jl-line)); }
.jl-stat.is-warn .jl-stat-value { color: var(--jl-warn); }
.jl-stat-hint { color: var(--jl-faint); font-size: 11px; }

/* ---- split lists ---- */
.jl-split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 820px) { .jl-split { grid-template-columns: 1fr; } }
.jl-list { list-style: none; margin: 0; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.jl-list-row { padding: 9px 12px; border: 1px solid var(--jl-line); border-radius: 10px; background: var(--jl-surface-2); }
.jl-list-title { font-weight: 550; font-size: 13px; }
.jl-list-sub { color: var(--jl-muted); font-size: 12px; }

/* ---- settings ---- */
.jl-form { display: flex; flex-direction: column; gap: 18px; padding: 16px; }
.jl-field { display: flex; flex-direction: column; gap: 6px; }
.jl-label { font-size: 13px; font-weight: 600; }
.jl-help { color: var(--jl-muted); font-size: 12px; }
.jl-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 44px; padding: 6px 8px; border: 1px solid var(--jl-line); border-radius: 10px; background: var(--jl-surface); }
.jl-tag-item { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 9px; border-radius: 8px; background: var(--jl-accent-weak); color: var(--jl-accent); font-size: 12px; font-weight: 550; }
.jl-tag-x { border: 0; background: transparent; color: inherit; padding: 0 4px; border-radius: 6px; line-height: 1.2; font-size: 14px; }
.jl-tag-x:hover { background: color-mix(in srgb, var(--jl-accent) 16%, transparent); }
.jl-tag-input { flex: 1 1 140px; min-width: 120px; border: 0; outline: none; background: transparent; padding: 4px; font-size: 13px; }
.jl-tag-input:focus-visible { outline: none; }
.jl-tags:focus-within { border-color: var(--jl-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--jl-accent) 18%, transparent); }
.jl-input-wide { width: 100%; max-width: 560px; }
.jl-input { width: 140px; padding: 8px 10px; border: 1px solid var(--jl-line); border-radius: 10px; background: var(--jl-surface); font-size: 13px; }
.jl-form-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.jl-note { color: var(--jl-muted); font-size: 12px; }
.jl-saved { color: var(--jl-ok); font-size: 12px; }
.jl-error { color: var(--jl-danger); font-size: 12px; }
.jl-inline-link { border: 0; background: transparent; color: var(--jl-accent); padding: 0; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }

.jl-loading { padding: 28px 16px; color: var(--jl-faint); font-size: 13px; }
`

/**
 * Install the stylesheet once.
 *
 * @returns a disposer that removes the element
 */
export function installStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => undefined
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.append(element)
  return () => {
    element.remove()
  }
}
