import { useCallback, useEffect, useState } from 'react';
import { deleteShare, fetchShares, revokeShare, shareUrl } from '../lib/shares';
import type { ShareWithCount } from '../lib/shares';
import { useI18n } from '../lib/i18n';
import { formatDate } from '../lib/format';
import { Note } from '../components/ui';

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setShares(await fetchShares());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  async function onRevoke(share: ShareWithCount) {
    if (!window.confirm(t('share.confirmRevoke', { title: share.title }))) return;
    await revokeShare(share.id);
    await load();
  }

  async function onDelete(share: ShareWithCount) {
    if (!window.confirm(t('share.confirmDelete', { title: share.title }))) return;
    await deleteShare(share.id);
    await load();
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t('share.title')}</h1>
        <p className="lede">{t('share.subtitle')}</p>
      </div>

      {error && <Note tone="error">{error}</Note>}

      {loading ? (
        <p className="small">{t('common.loading')}…</p>
      ) : shares.length === 0 ? (
        <div className="empty">
          <h2>{t('share.emptyTitle')}</h2>
          <p className="lede">{t('share.emptyBody')}</p>
        </div>
      ) : (
        <ul className="share-list">
          {shares.map((s) => {
            const status = state(s);
            const count = s.share_items[0]?.count ?? 0;
            return (
              <li className="share-card" key={s.id} data-state={status}>
                <div className="share-card__main">
                  <h2>{s.title}</h2>
                  <p className="small">
                    {t('share.itemCount', { n: count })}
                    {' · '}
                    {t('share.views', { n: s.view_count })}
                    {s.expires_at && ` · ${t('share.until', {
                      date: formatDate(s.expires_at, locale) ?? '',
                    })}`}
                  </p>
                  {status !== 'active' && (
                    <span className="chip">{t(`share.state.${status}`)}</span>
                  )}
                </div>

                <div className="share-card__actions">
                  {status === 'active' && (
                    <>
                      <button className="btn btn--bare" onClick={() => void copy(s.token)}>
                        {copied === s.token ? t('share.copied') : t('share.copy')}
                      </button>
                      <button className="btn btn--bare" onClick={() => void onRevoke(s)}>
                        {t('share.revoke')}
                      </button>
                    </>
                  )}
                  <button className="btn btn--bare" onClick={() => void onDelete(s)}>
                    {t('common.delete')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
