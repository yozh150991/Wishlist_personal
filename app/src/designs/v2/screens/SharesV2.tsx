import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, Copy, Eye, Link2 } from 'lucide-react';
import { deleteShare, fetchSharesOverview, revokeShare, shareUrl } from '../../../lib/shares';
import type { ShareOverview } from '../../../lib/shares';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { formatDeadline } from '../../../lib/format';
import { NoteV2 } from './AuthPartsV2';
import { SheetV2, useCounts } from './CommonV2';
import { ConfirmSheetV2 } from './ListPartsV2';

const STROKE = 2.75;
/** «Скопійовано» живе дві секунди (README, «Мої посилання»). */
const COPIED_MS = 2000;

type State = 'active' | 'revoked' | 'expired';

function stateOf(share: ShareOverview): State {
  if (share.revoked_at) return 'revoked';
  if (share.expires_at && new Date(share.expires_at) < new Date()) return 'expired';
  return 'active';
}

/**
 * «Мої посилання» v2 (README, розділ 4; потік D).
 *
 * Два блоки: ті, що діють, і ті, що вже ні (відкликані чи з вичерпаним
 * терміном) — у мертвих лишається тільки «Видалити». На картці — назва,
 * список, з якого посилання, «6 позицій · 23 перегляди · до 20 грудня».
 *
 * Перегляди — не позначки: лічильник нічого не каже про те, чи щось узяли,
 * тому він дозволений. Поруч не з'являється нічого, що з позначками корелює
 * (CLAUDE.md §3.2, ADR-040).
 *
 * Збереженої копії без мережі тут немає й не буде: токени не кешуються
 * (CLAUDE.md §3.5) — без мережі сторінка чесно каже «Немає зʼєднання».
 */
export default function SharesV2() {
  const { t, locale } = useI18n();
  const counts = useCounts();
  const [shares, setShares] = useState<ShareOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Браузер не дав скопіювати — адреса у вікні, щоб скопіювати руками. */
  const [manual, setManual] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ share: ShareOverview; kind: 'revoke' | 'delete' } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setShares(await fetchSharesOverview());
      setError(null);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(id);
  }, [copied]);

  const groups = useMemo(() => {
    const live = shares.filter((s) => stateOf(s) === 'active');
    const dead = shares.filter((s) => stateOf(s) !== 'active');
    return { live, dead };
  }, [shares]);

  async function copy(token: string) {
    const url = shareUrl(token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setManual(url);
    }
  }

  async function onConfirm() {
    if (!confirm || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      if (confirm.kind === 'revoke') await revokeShare(confirm.share.id);
      else await deleteShare(confirm.share.id);
      setConfirm(null);
      await load();
    } catch (e) {
      setConfirm(null);
      setActionError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  function card(s: ShareOverview) {
    const state = stateOf(s);
    const count = s.share_items[0]?.count ?? 0;
    const deadline = formatDeadline(s.expires_at, s.expires_tz, locale);
    const meta = [
      counts.items(count),
      counts.views(s.view_count ?? 0),
      deadline
        ? state === 'expired'
          ? t('share.untilPast', { date: deadline.day })
          : t('share.until', { date: deadline.day })
        : null,
    ].filter(Boolean);
    return (
      <li key={s.id} className="v2-sharecard" data-state={state}>
        <div className="v2-sharecard__head">
          <h3 className="v2-sharecard__title">{s.title}</h3>
          {state !== 'active' && (
            <span className="v2-tag" data-tone="neutral">
              {state === 'revoked' ? t('share.state.revoked') : t('share.state.expired')}
            </span>
          )}
        </div>
        {s.list_title && <p className="v2-sharecard__list">{t('v2shares.fromList', { title: s.list_title })}</p>}
        <p className="v2-sharecard__meta">{meta.join(' · ')}</p>
        <div className="v2-sharecard__actions">
          {state === 'active' && (
            <>
              <button type="button" className="v2-btn v2-btn--primary v2-btn--small" onClick={() => void copy(s.token)}>
                <Copy size={18} strokeWidth={STROKE} aria-hidden="true" />
                {t('share.copy')}
              </button>
              <button
                type="button"
                className="v2-btn v2-btn--outline v2-btn--small"
                onClick={() => setConfirm({ share: s, kind: 'revoke' })}
              >
                {t('share.revoke')}
              </button>
              {/* Справжня гостьова з банером «Це твоє посилання»: броней там не видно (§3.2). */}
              <Link
                to={`/l/${s.token}`}
                className="v2-btn v2-btn--ghost v2-btn--small v2-sharecard__open"
                aria-label={t('v2shares.openLabel', { title: s.title })}
              >
                <Eye size={18} strokeWidth={STROKE} aria-hidden="true" />
                {t('v2shares.open')}
              </Link>
            </>
          )}
          {/* У відкликаного й протермінованого лишається тільки видалення:
              решта дій із мертвим посиланням безглузда. */}
          <button
            type="button"
            className="v2-btn v2-btn--danger v2-btn--small"
            aria-label={t('v2shares.deleteLabel', { title: s.title })}
            onClick={() => setConfirm({ share: s, kind: 'delete' })}
          >
            {t('common.delete')}
          </button>
        </div>
      </li>
    );
  }

  return (
    <main className="v2-page" aria-busy={loading || undefined}>
      <div className="v2-head">
        <h1 className="v2-page__title">{t('share.title')}</h1>
        <p className="v2-lede">{t('v2shares.subtitle')}</p>
      </div>

      {actionError && <NoteV2 tone="error">{actionError}</NoteV2>}

      {loading ? (
        <>
          <span className="v2-sr">{t('share.loading')}</span>
          <ul className="v2-sharegrid" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="v2-sharecard v2-sharecard--sk" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </ul>
        </>
      ) : error ? (
        <div className="v2-empty">
          <span className="v2-circle v2-circle--warm" aria-hidden="true">
            <AlertCircle size={32} strokeWidth={STROKE} />
          </span>
          <h2 className="v2-empty__title">{t('share.errorTitle')}</h2>
          <p className="v2-lede" role="alert">
            {error}
          </p>
          <button type="button" className="v2-btn v2-btn--primary" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </div>
      ) : shares.length === 0 ? (
        <div className="v2-empty">
          <span className="v2-circle v2-circle--calm" aria-hidden="true">
            <Link2 size={32} strokeWidth={STROKE} />
          </span>
          <h2 className="v2-empty__title">{t('share.emptyTitle')}</h2>
          {/* Назви кнопок у підказці — ті самі ключі, що на кнопках: розбіжність
              «Поділитися» проти «Створити посилання» вже була багом (README D). */}
          <p className="v2-lede">
            {t('v2shares.emptyBody', { share: t('v2list.share'), create: t('share.create') })}
          </p>
          <Link to="/lists" className="v2-btn v2-btn--primary">
            {t('v2list.back')}
          </Link>
        </div>
      ) : (
        <div className="v2-groups">
          {groups.live.length > 0 && (
            <section aria-labelledby="v2-shares-live">
              <h2 className="v2-kicker" id="v2-shares-live">
                {t('v2shares.live')} · {groups.live.length}
              </h2>
              <ul className="v2-sharegrid">{groups.live.map(card)}</ul>
            </section>
          )}
          {groups.dead.length > 0 && (
            <section aria-labelledby="v2-shares-dead">
              <h2 className="v2-kicker" id="v2-shares-dead">
                {t('v2shares.dead')} · {groups.dead.length}
              </h2>
              <ul className="v2-sharegrid">{groups.dead.map(card)}</ul>
            </section>
          )}
        </div>
      )}

      {/* Підтвердження там, куди дивиться палець, а не там, де була кнопка. */}
      {copied && (
        <p className="v2-pill" role="status">
          <Check size={16} strokeWidth={STROKE} aria-hidden="true" />
          {t('share.copied')}
        </p>
      )}

      <SheetV2 open={manual !== null} onClose={() => setManual(null)} labelledBy="v2-manual-title">
        <h2 className="v2-sheet__title" id="v2-manual-title">
          {t('share.link')}
        </h2>
        <p className="v2-lede">{t('v2shares.copyManual')}</p>
        <input
          className="v2-input"
          readOnly
          aria-labelledby="v2-manual-title"
          value={manual ?? ''}
          onFocus={(e) => e.target.select()}
        />
        <button type="button" className="v2-btn v2-btn--ghost" onClick={() => setManual(null)}>
          {t('common.close')}
        </button>
      </SheetV2>

      <ConfirmSheetV2
        open={confirm !== null}
        id="v2-shares-confirm"
        title={
          confirm?.kind === 'revoke'
            ? t('share.confirmRevokeTitle', { title: confirm.share.title })
            : t('share.confirmDeleteTitle', { title: confirm?.share.title ?? '' })
        }
        body={confirm?.kind === 'revoke' ? t('v2share.revokeBody') : t('share.confirmDeleteBody')}
        confirmLabel={confirm?.kind === 'revoke' ? t('v2share.revokeConfirm') : t('common.delete')}
        busyLabel={confirm?.kind === 'revoke' ? t('v2share.revoking') : t('lists.deleting')}
        busy={busy}
        onConfirm={() => void onConfirm()}
        onClose={() => setConfirm(null)}
      />
    </main>
  );
}
