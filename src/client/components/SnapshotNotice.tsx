import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';

/** "il y a 12 min", "il y a 3 h", "hier à 07:12" — the shapes someone actually reads. */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const min = Math.round(ms / 60_000);
  if (min < 2) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 10) return `il y a ${h} h`;
  const d = new Date(iso);
  const jour = ms < 36 * 3_600_000 ? 'hier' : d.toLocaleDateString('fr-FR');
  return `${jour} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Says when a figure was computed, and offers to redo it.
 *
 * The whole-corpus aggregates read every message — 7.6 s for the costs — so they are taken once a
 * day rather than on every page load. That is a fair trade for totals describing months of work,
 * but only if the page says so: a number presented as live when it is this morning's is the kind
 * of thing that ends up on an invoice.
 */
export function SnapshotNotice({ computedAt, onRefreshed }: { computedAt?: string; onRefreshed: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!computedAt) return null;
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>Chiffres arrêtés {ago(computedAt)}.</span>
      <button
        onClick={async () => {
          setBusy(true);
          try {
            await api.refreshStats();
            onRefreshed();
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
        {busy ? 'Recalcul…' : 'Recalculer'}
      </button>
    </p>
  );
}
