import { useEffect, useId, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { errorText } from '../lib/errors';
import { formatDay } from '../lib/format';
import {
  APPEARANCE_NAME_MAX,
  checkAppearanceName,
  createAppearance,
  deleteAppearance,
  fetchAppearances,
  setListAppearance,
} from '../lib/appearances';
import type { Appearance } from '../lib/appearances';
import { DEFAULT_HUE, HUE_PRESETS, normalizeHue, overlayVars } from '../lib/hue-ramp.js';
import type { List } from '../lib/types';
import { ConfirmDialog, Dialog } from './Dialog';
import { Icon } from './Icon';
import { Field, Note } from './ui';

/**
 * «Оформлення списку» — другий шар вигляду, що належить власникові (ADR-034).
 *
 * Живе в самому списку, а не в Налаштуваннях: це вигляд події, а не смак
 * людини. Перелік: «Без оформлення», три вбудовані події, свої, «Новий вигляд».
 * Вибір застосовується одразу — діалог нічого не питає: це зворотна дія.
 *
 * Аркуш «Новий вигляд» має один регулятор — відтінок — і живий приклад. Поля
 * «світлість» чи «насиченість» у ньому немає й не буде: світлість задає
 * генератор (lib/hue-ramp.js), тож людина не може обрати непридатне.
 */

/**
 * Кружечок відтінку — як і зразки схем, єдине місце, де колір показується як
 * колір. Значення рахує генератор із H; у коді літералу немає.
 */
function HueDot({ hue, size = 22 }: { hue: number; size?: number }) {
  const { resolved } = useTheme();
  const vars = overlayVars(hue, resolved.theme);
  const color = resolved.theme === 'dark' ? vars['--color-accent-500'] : vars['--color-accent-700'];
  return (
    <span
      className="hue-dot"
      aria-hidden="true"
      style={{ background: color, width: size, height: size } as CSSProperties}
    />
  );
}

/** Змінні оверлею як inline-стиль обгортки — для живого прикладу. */
function overlayStyle(hue: number, theme: 'light' | 'dark'): CSSProperties {
  return overlayVars(hue, theme) as CSSProperties;
}

export function AppearanceDialog({
  open,
  list,
  onClose,
  onChanged,
  onPreview,
}: {
  open: boolean;
  list: List | null;
  onClose: () => void;
  /** Новий id оформлення списку (або null) — сторінка оновлює свій стан. */
  onChanged: (appearanceId: string | null) => void;
  onPreview: () => void;
}) {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const { resolved } = useTheme();
  const hueId = useId();

  const [items, setItems] = useState<Appearance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [toDelete, setToDelete] = useState<Appearance | null>(null);
  const [deleting, setDeleting] = useState(false);

  // «Новий вигляд»
  const [name, setName] = useState('');
  const [hue, setHue] = useState<number>(DEFAULT_HUE);
  const [custom, setCustom] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const current = list?.appearance_id ?? null;

  async function load() {
    try {
      setItems(await fetchAppearances());
      setError(null);
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  useEffect(() => {
    if (!open) return;
    setMode('pick');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function label(a: Appearance): string {
    return a.builtin_key ? t(`appearance.builtin.${a.builtin_key}`) : a.name;
  }

  async function choose(id: string | null) {
    if (!list || busyId || id === current) return;
    setBusyId(id ?? 'none');
    setError(null);
    try {
      await setListAppearance(list.id, id);
      onChanged(id);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusyId(null);
    }
  }

  function startNew() {
    setName('');
    setHue(DEFAULT_HUE);
    setCustom(false);
    setNameError(null);
    setMode('new');
  }

  async function saveNew(e: FormEvent) {
    e.preventDefault();
    if (saving || !list || !session) return;
    const problem = checkAppearanceName(name);
    if (problem) {
      setNameError(problem === 'emoji' ? t('appearance.nameEmoji') : t('appearance.nameEmpty'));
      return;
    }
    setSaving(true);
    setNameError(null);
    try {
      const created = await createAppearance(session.user.id, name, hue);
      await setListAppearance(list.id, created.id);
      onChanged(created.id);
      await load();
      setMode('pick');
    } catch (err) {
      setNameError(errorText(err, t));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteAppearance(toDelete.id);
      if (toDelete.id === current) onChanged(null);
      setToDelete(null);
      await load();
    } catch (e) {
      setError(errorText(e, t));
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  const builtin = (items ?? []).filter((a) => a.builtin_key);
  const mine = (items ?? []).filter((a) => !a.builtin_key);
  const locked = resolved.locked === 'a11y';

  if (mode === 'new') {
    const problem = name ? checkAppearanceName(name) : null;
    return (
      // Ключ — інакше React перевикористав би той самий <dialog> із переліку,
      // і фокус не став би на перше поле нового аркуша.
      <Dialog key="new" open={open} onClose={onClose} title={t('appearance.new')}>
        <form className="form-grid" noValidate onSubmit={saveNew}>
          <Field
            label={t('appearance.name')}
            name="appearanceName"
            maxLength={APPEARANCE_NAME_MAX}
            count
            value={name}
            error={nameError ?? (problem === 'emoji' ? t('appearance.nameEmoji') : undefined)}
            hint={t('appearance.namePrivate')}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
          />

          <div className="field">
            <span className="field__label-row">
              <span className="settings__label" id={hueId}>
                {t('appearance.hue')}
              </span>
              <span className="small muted">{t('appearance.hueHint')}</span>
            </span>
            <div className="hue-grid" role="radiogroup" aria-labelledby={hueId}>
              {HUE_PRESETS.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={!custom && hue === h}
                  aria-label={t('appearance.hueSwatch', { h })}
                  className="hue-swatch"
                  style={overlayStyle(h, resolved.theme)}
                  onClick={() => {
                    setCustom(false);
                    setHue(h);
                  }}
                />
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={custom}
                aria-label={t('appearance.customHue')}
                className="hue-swatch hue-swatch--custom"
                onClick={() => setCustom(true)}
              >
                <Icon name="plus" size={18} />
              </button>
            </div>
            {custom && (
              <label className="hue-slider">
                <span className="small">{t('appearance.customHue')}</span>
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={hue}
                  onChange={(e) => setHue(normalizeHue(Number(e.target.value)))}
                />
                <span className="small muted">{hue}°</span>
              </label>
            )}
          </div>

          <div className="field">
            <span className="settings__label">{t('appearance.example')}</span>
            {/* Живий приклад — шматок гостьової в цьому відтінку поверх твоєї
                схеми. Висока контрастність вимикає оформлення й тут: людина,
                якій воно заважає бачити, не має отримати його у превʼю. */}
            <div
              className="appearance-sample guest"
              style={locked ? undefined : overlayStyle(hue, resolved.theme)}
            >
              <div className="guest__head">
                {formatDay(list?.event_date ?? null, locale) && (
                  <p className="guest__kicker">{formatDay(list?.event_date ?? null, locale)}</p>
                )}
                <p className="appearance-sample__title">{list?.title}</p>
              </div>
              <div className="gcard">
                <div className="gcard__top">
                  <span className="prio" data-prio="high" aria-hidden="true" />
                  <p className="gcard__title">{t('appearance.sampleItem')}</p>
                </div>
                <span className="btn btn--primary btn--block" aria-hidden="true">
                  {t('guest.take')}
                </span>
              </div>
            </div>
            {locked && <p className="small muted">{t('appearance.a11yLocked')}</p>}
          </div>

          <div className="dialog__foot">
            <button type="button" className="btn btn--secondary" onClick={() => setMode('pick')}>
              {t('appearance.back')}
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving && <span className="spinner" />}
              {saving ? t('appearance.saving') : t('appearance.save')}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <>
      <Dialog key="pick" open={open} onClose={onClose} title={t('appearance.title')}>
        {error && <Note tone="error">{error}</Note>}

        <div className="appearance-list" role="radiogroup" aria-label={t('appearance.title')}>
          <button
            type="button"
            role="radio"
            aria-checked={current === null}
            className="appearance-row"
            disabled={Boolean(busyId)}
            onClick={() => void choose(null)}
          >
            <span className="hue-dot hue-dot--none" aria-hidden="true" />
            <span className="appearance-row__name">{t('appearance.none')}</span>
            <span className="small muted">{t('appearance.noneHint')}</span>
            {current === null && <Icon name="check" size={18} />}
          </button>

          {builtin.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={current === a.id}
              className="appearance-row"
              disabled={Boolean(busyId)}
              onClick={() => void choose(a.id)}
            >
              <HueDot hue={a.hue} />
              <span className="appearance-row__name">{label(a)}</span>
              {busyId === a.id && <span className="spinner" />}
              {current === a.id && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>

        {mine.length > 0 && (
          <div className="appearance-list">
            <span className="settings__label">{t('appearance.mine')}</span>
            {mine.map((a) => (
              <div className="appearance-row appearance-row--own" key={a.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={current === a.id}
                  className="appearance-row__pick"
                  disabled={Boolean(busyId)}
                  onClick={() => void choose(a.id)}
                >
                  <HueDot hue={a.hue} />
                  <span className="appearance-row__name">{a.name}</span>
                  {a.list_count > 0 && (
                    <span className="small muted">{t('appearance.inLists', { n: a.list_count })}</span>
                  )}
                  {busyId === a.id && <span className="spinner" />}
                  {current === a.id && <Icon name="check" size={18} />}
                </button>
                <button
                  type="button"
                  className="btn btn--icon btn--ghost"
                  aria-label={t('appearance.delete', { name: a.name })}
                  onClick={() => setToDelete(a)}
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
            ))}
          </div>
        )}

        <button type="button" className="btn btn--secondary btn--block" onClick={startNew}>
          <Icon name="plus" size={18} />
          {t('appearance.new')}
        </button>

        <div className="appearance-note">
          <strong>{t('appearance.guestsSee')}</strong>
          <p className="small">{t('appearance.guestsSeeBody')}</p>
        </div>

        <button type="button" className="btn btn--primary btn--block" onClick={onPreview}>
          {t('appearance.preview')}
        </button>
      </Dialog>

      <ConfirmDialog
        open={Boolean(toDelete)}
        title={t('appearance.confirmDeleteTitle', { name: toDelete?.name ?? '' })}
        body={t('appearance.confirmDeleteBody')}
        confirmLabel={t('appearance.confirmDelete')}
        busyLabel={t('appearance.deleting')}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
