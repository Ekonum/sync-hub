import { useEffect, useState } from 'react';
import { AlertTriangle, Receipt, Settings2 } from 'lucide-react';
import type { BillableAmount, BillingSettings } from '../../core/billing.js';
import { api } from '../lib/api.js';

const eur = (n: number) =>
  n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: n < 100 ? 2 : 0 });

const hours = (h: number) => (h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`);

/**
 * What a period of work comes to, on whatever the page is already scoped to.
 *
 * One block rather than a dashboard: the request was for the two analyses joined, and above all not
 * complicated. So there is a total, the two lines that make it, and — in the same breath — what was
 * deliberately left out of it. A figure that goes on an invoice has to be defensible without
 * opening the code, which means the exclusions belong beside the total and not in a tooltip.
 */
export function BillingPanel({
  scope,
  onSettingsChanged,
}: {
  scope: { projectId?: string; category?: string; startDate?: string; endDate?: string };
  onSettingsChanged?: () => void;
}) {
  const [data, setData] = useState<{ amount: BillableAmount; settings: BillingSettings } | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<BillingSettings | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [computedAt, setComputedAt] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .billing(scope)
      .then((r) => {
        if (cancelled) return;
        setData({ amount: r.amount, settings: r.settings });
        setComputedAt(r.computedAt);
      })
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [scope.projectId, scope.category, scope.startDate, scope.endDate, reload]);

  // A block that vanishes while it loads reads as a block that is not there — and the figure it
  // carries is the one somebody came to the page for.
  if (!data) {
    return loading ? (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        Calcul du montant à refacturer…
      </div>
    ) : null;
  }
  const { amount, settings } = data;
  const notConfigured = settings.hourlyRateEur === 0;

  return (
    <div className="stack rounded-xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-accent" />
          <h2 className="text-base font-semibold text-foreground">À refacturer</h2>
          {loading && <span className="text-sm text-muted-foreground">mise à jour…</span>}
        </div>
        <button
          onClick={() => {
            setDraft(settings);
            setEditing((e) => !e);
          }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          <Settings2 size={12} />
          Réglages
        </button>
      </div>

      {notConfigured ? (
        <p className="text-sm text-muted-foreground">
          Aucun taux horaire n'est réglé, donc le temps n'est pas facturé — seuls les jetons sont
          chiffrés. Renseigne un taux dans les réglages pour obtenir un montant.
        </p>
      ) : null}

      <div className="text-3xl font-bold text-foreground">{eur(amount.totalEur)}</div>
      {computedAt && (
        // Only the unscoped total comes from the daily pass; a scoped one is computed live and
        // carries no date, which is exactly the distinction worth showing.
        <p className="text-sm text-muted-foreground">
          Vue d'ensemble, arrêtée au {new Date(computedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}.
          Choisis un projet ou une période pour un montant calculé à l'instant.
        </p>
      )}

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-background/50 p-4">
          <dt className="text-sm text-muted-foreground">
            Temps — {hours(amount.billableHours)} à {eur(settings.hourlyRateEur)}/h
          </dt>
          <dd className="mt-1 text-xl font-semibold text-foreground">{eur(amount.timeAmountEur)}</dd>
          <p className="mt-2 text-sm text-muted-foreground">
            Rédaction estimée, plafonnée par le temps réellement écoulé.
            {amount.excluded.waitingTimeNotBilled
              ? ` L'attente des réponses (${hours(amount.waitingHours)}) est mesurée mais n'est pas facturée.`
              : ' L’attente des réponses est incluse.'}
          </p>
        </div>

        <div className="rounded-xl border border-border/60 bg-background/50 p-4">
          <dt className="text-sm text-muted-foreground">
            Jetons — {eur(amount.tokenCostEur)}
            {settings.tokenMarginPercent !== 0 ? ` ${settings.tokenMarginPercent > 0 ? '+' : ''}${settings.tokenMarginPercent} %` : ''}
          </dt>
          <dd className="mt-1 text-xl font-semibold text-foreground">{eur(amount.tokenAmountEur)}</dd>
          <p className="mt-2 text-sm text-muted-foreground">
            Consommation mesurée et interpolée, aux tarifs publiés.
          </p>
        </div>
      </dl>

      {(amount.excluded.upperBoundEur > 0 || amount.excluded.unpricedMessageCount > 0) && (
        <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="stack-tight">
            <p className="font-medium text-foreground">Volontairement hors du total</p>
            {amount.excluded.upperBoundEur > 0 && (
              <p>
                {eur(amount.excluded.upperBoundEur)} de borne haute d'archives. Un export ne dit ni
                quel modèle a répondu ni ce qu'il a consommé : ce montant suppose le modèle le plus
                cher de l'époque. C'est un ordre de grandeur, pas un prix.
              </p>
            )}
            {amount.excluded.unpricedMessageCount > 0 && (
              <p>
                {amount.excluded.unpricedMessageCount.toLocaleString('fr-FR')} messages dont le
                modèle n'a pas de tarif publié, comptés à zéro plutôt que devinés.
              </p>
            )}
          </div>
        </div>
      )}

      {editing && draft && (
        <div className="stack rounded-xl border border-border bg-background/50 p-4">
          <label className="stack-tight">
            <span className="label">Taux horaire (€)</span>
            <input
              type="number"
              min={0}
              max={10000}
              step={5}
              value={draft.hourlyRateEur}
              onChange={(e) => setDraft({ ...draft, hourlyRateEur: Number(e.target.value) })}
              className="w-40 rounded-xl border border-border bg-card px-2 py-2 text-sm text-foreground"
            />
          </label>
          <label className="stack-tight">
            <span className="label">Marge sur les jetons (%)</span>
            <input
              type="number"
              min={-100}
              max={1000}
              step={5}
              value={draft.tokenMarginPercent}
              onChange={(e) => setDraft({ ...draft, tokenMarginPercent: Number(e.target.value) })}
              className="w-40 rounded-xl border border-border bg-card px-2 py-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">
              Négatif pour n'en répercuter qu'une partie ; −100 % pour l'absorber entièrement.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={draft.billWaitingTime}
              onChange={(e) => setDraft({ ...draft, billWaitingTime: e.target.checked })}
              className="mt-1"
            />
            <span className="text-sm text-foreground">
              Facturer aussi l'attente des réponses
              <span className="block text-muted-foreground">
                Mesurée, pas estimée — mais c'est du temps pendant lequel on peut faire autre chose.
              </span>
            </span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  await api.setBillingSettings(draft);
                  setEditing(false);
                  setReload((r) => r + 1);
                  onSettingsChanged?.();
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <button onClick={() => setEditing(false)} className="rounded-xl border border-border px-4 py-2 text-sm text-muted-foreground">
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
