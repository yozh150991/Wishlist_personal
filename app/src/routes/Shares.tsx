import { useCallback, useEffect, useState } from 'react';
import { deleteShare, fetchShares, revokeShare, shareUrl } from '../lib/shares';
import type { ShareWithCount } from '../lib/shares';
import { useI18n } from '../lib/i18n';
import { errorText } from '../lib/errors';
import { formatDate } from '../lib/format';
import { ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';

function state(share: ShareWithCount): 'revoked' | 'expired' | 'active' {
  if (share.revoked_at) return 'revoked';
  if (share.expires_at && new Date(share.expires_at) < new Date()) return 'expired';
  return 'active';
}

export default function Shares() {
  const { t, locale } = useI18n();
  const [shares, setShares] = useState<ShareWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ share: ShareWithCount; kind: 'revoke' | 'delete' } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setShares(await fetchShares());
      setError(null);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(token: string) {
    await navigator.clipboard.writeText(shareUrl(token));
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  }

  async function onConfirm() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      if (confirm.kind === 'revoke') await revokeShare(confirm.share.id);
      else await deleteShare(confirm.share.id);
      setConfirm(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div className="list-head__text">
          <h1>{t('share.title')}</h1>
          <p className="lede small">{t('share.subtitle')}</p>
        </div>
      </div>

      {loading ? (
        <main aria-busy="true">
          <span className="visually-hidden">{t('share.loading')}</span>
          <ul className="share-list">
            {[0, 1, 2].map((i) => (
              <li className="share-card sk" key={i}>
                <span className="sk__line sk__line--title" style={{ width: '58%' }} />
                <span className="sk__line" style={{ width: '76%' }} />
                <span className="sk__tags">
                  <span className="sk__line sk__line--row" style={{ width: '96px' }} />
                  <span className="sk__line sk__line--row" style={{ width: '110px' }} />
                </span>
              </li>
            ))}
          </ul>
        </main>
      ) : error ? (
        <main className="empty">
          <span className="empty__icon empty__icon--danger">
            <Icon name="alert" size={36} />
          </span>
          <h2>{t('share.errorTitle')}</h2>
          <p className="lede">{error}</p>
          <button type="button" className="btn btn--primary" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </main>
      ) : shares.length === 0 ? (
        <main className="empty">
          <span className="empty__icon">
            <Icon name="link" size={40} />
          </span>
          <h2>{t('share.emptyTitle')}</h2>
          {/* Назва кнопки в підказці мусить дослівно збігатися з реальною
              кнопкою на екрані списку — інакше людина шукатиме не те. */}
          <p className="lede">{t('share.emptyBody')}</p>
        </main>
      ) : (
        <main>
          <ul className="share-list">
            {shares.map((s) => {
              const status = state(s);
              const count = s.share_items[0]?.count ?? 0;
              return (
                <li className="share-card" key={s.id} data-state={status}>
                  <div className="share-card__head">
                    <h2 className="share-card__title">{s.title}</h2>
                    {status !== 'active' && (
                      <span className="tag tag--neutral">{t(`share.state.${status}`)}</span>
                    )}
                  </div>

                  {/* Переглядів — не броней: лічильник нічого не каже про те,
                      чи щось узяли. Поруч не має з'явитися нічого, що з
                      бронями корелює (CLAUDE.md §3.2). */}
                  <p className="small muted">
                    {t('share.itemCount', { n: count })}
                    {' · '}
                    {t('share.views', { n: s.view_count })}
                    {s.expires_at &&
                      ` · ${t('share.until', { date: formatDate(s.expires_at, locale) ?? '' })}`}
                  </p>

                  <div className="share-card__actions">
                    {status === 'active' && (
                      <>
                        <button
                          type="button"
                          className="btn btn--primary btn--compact"
                          onClick={() => void copy(s.token)}
                        >
                          <Icon name="copy" size={16} />
                          {t('share.copy')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--compact"
                          onClick={() => setConfirm({ share: s, kind: 'revoke' })}
                        >
                          {t('share.revoke')}
                        </button>
                      </>
                    )}
                    {/* У відкликаного й протермінованого лишається тільки
                        видалення: решта дій із мертвим посиланням безглузда. */}
                    <button
                      type="button"
                      className="btn btn--secondary btn--compact btn--danger"
                      onClick={() => setConfirm({ share: s, kind: 'delete' })}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </main>
      )}

      {/* Пігулка «Скопійовано» знизу по центру: підтвердження має бути видно
          там, куди дивиться палець, а не там, де була кнопка. */}
      {copied && (
        <p className="toast" role="status">
          <Icon name="check" size={16} />
          {t('share.copied')}
        </p>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'revoke'
            ? t('share.confirmRevokeTitle', { title: confirm?.share.title ?? '' })
            : t('share.confirmDeleteTitle', { title: confirm?.share.title ?? '' })
        }
        body={confirm?.kind === 'revoke' ? t('share.confirmRevokeBody') : t('share.confirmDeleteBody')}
        confirmLabel={confirm?.kind === 'revoke' ? t('share.revoke') : t('common.delete')}
        busy={busy}
        onConfirm={() => void onConfirm()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
