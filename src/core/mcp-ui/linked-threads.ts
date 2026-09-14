/**
 * The card Cowork draws when the assistant asks what moved in the linked threads.
 *
 * MCP Apps (SEP-1865, final since January 2026) lets a server hand the host a self-contained HTML
 * document under a `ui://` URI; the host renders it in a sandboxed iframe and pushes the tool
 * result in over postMessage. So this is not an extension written per application — it is a
 * resource added to the MCP server sync-hub already exposes, and the sandbox is what makes it
 * safe: at worst the card does not appear.
 *
 * Read-only, deliberately. The tool it hangs off advances each thread's cursor every time it runs,
 * so a card that called it again would consume the very updates it is meant to show. Nothing here
 * calls back into the host.
 *
 * Self-contained on purpose too: no fonts, no scripts, no images from anywhere. A UI resource may
 * declare the domains it needs, and needing none is the easiest promise to keep.
 */

export const LINKED_THREADS_URI = 'ui://sync-hub/linked-threads';

/** What the tool puts in `structuredContent` for this card to draw. */
export interface LinkedThreadsView {
  /** The thread that asked. Shown as "celui-ci" rather than repeated. */
  threadId: string;
  threads: Array<{
    id: string;
    title: string;
    /** Human label — "Claude Code", "Codex"… */
    engine: string;
    project: string | null;
    updatedAt: string;
    /** Messages in this delta, for the threads other than the asking one. */
    newMessages: number;
  }>;
}

export const LINKED_THREADS_HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  :root {
    color-scheme: light dark;
    --ink: #1c1a17;
    --muted: #6f6862;
    --line: #e6e1da;
    --ground: transparent;
    --chip: #f3efe9;
    --accent: #c2643b;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #ece7e1; --muted: #a09890; --line: #3a3530; --chip: #2a2622; --accent: #e08a5e; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  h1 { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
  .sub { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
  li { display: flex; align-items: baseline; gap: 8px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; transform: translateY(-2px); }
  .dot.self { background: var(--muted); opacity: .5; }
  .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .spacer { flex: 1 1 auto; min-width: 8px; }
  .badge {
    flex: none; background: var(--chip); color: var(--ink);
    border-radius: 999px; padding: 1px 8px; font-size: 12px; font-variant-numeric: tabular-nums;
  }
  .empty { color: var(--muted); }
</style>
<div class="card" id="root" hidden></div>
<script>
  var root = document.getElementById('root');

  function ago(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return '';
    var min = Math.round(ms / 60000);
    if (min < 2) return "à l'instant";
    if (min < 60) return 'il y a ' + min + ' min';
    var h = Math.round(min / 60);
    if (h < 24) return 'il y a ' + h + ' h';
    return 'il y a ' + Math.round(h / 24) + ' j';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render(view) {
    var threads = (view && view.threads) || [];
    if (!threads.length) return; // nothing to show is shown as nothing
    var total = threads.reduce(function (n, t) { return n + (t.newMessages || 0); }, 0);

    var rows = threads.map(function (t) {
      var self = t.id === view.threadId;
      return '<li>'
        + '<span class="dot' + (self ? ' self' : '') + '"></span>'
        + '<span class="title">' + esc(t.title) + '</span>'
        + '<span class="spacer"></span>'
        + '<span class="meta">' + esc(t.engine) + (t.project ? ' · ' + esc(t.project) : '')
        + (self ? ' · celui-ci' : ' · ' + esc(ago(t.updatedAt))) + '</span>'
        + (t.newMessages ? '<span class="badge">+' + t.newMessages + '</span>' : '')
        + '</li>';
    }).join('');

    root.innerHTML =
      '<h1>' + threads.length + ' fils liés</h1>'
      + '<p class="sub">' + (total ? total + ' message' + (total > 1 ? 's' : '') + ' arrivé' + (total > 1 ? 's' : '') + ' ailleurs depuis la dernière vérification.' : 'Rien de nouveau ailleurs.') + '</p>'
      + '<ul>' + rows + '</ul>';
    root.hidden = false;
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.method !== 'ui/notifications/tool-result') return;
    try {
      render(data.params && data.params.structuredContent);
    } catch (e) {
      // Silence is the contract: a card that cannot draw shows nothing rather than an error
      // inside somebody's conversation.
    }
  });
</script>`;
